import { LitElement, html, svg, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Contact, HomeAssistant, PanelConfig } from '../types';
import { hasCoordinates as hasRadioCoordinates, nodeCoordinates, pathHashes as parsePathHashes, payloadTypeName as radioPayloadTypeName } from '../meshcore-radio';

interface MapNode {
  contact: Contact;
  lat: number;
  lon: number;
}

interface MessageMapPoint { key: string; name: string; lat: number; lon: number; }
interface MessageMapRoute { points: MessageMapPoint[]; hashPath: string[]; snr?: number; rssi?: number; }
interface MessageMapState { sender: string; target: string; text: string; channel?: string; pubkeyPrefix?: string; timestamp?: string; routes: MessageMapRoute[]; }
interface MapTile { x: number; y: number; left: number; top: number; src: string; }
interface TileTransition { tiles: MapTile[]; scale: number; }
interface RawRadioRow {
  id: number; time: string; type: string; route: string; path: string;
  message: string; coordinates: string; snr: string; rssi: string; noise: string; telemetry: string;
  hashes: string[]; payloadType?: number; payloadName?: string;
  /** Original RX_LOG_DATA snapshot so historical rows can rebuild the exact route. */
  eventData?: Record<string, unknown>;
  rxData?: Record<string, unknown>;
}
interface GraphEdge {
  id: string;
  from: MessageMapPoint;
  to: MessageMapPoint;
  count: number;
  lastSeen: number;
  flowStartedAt: number;
  snr?: number;
  rssi?: number;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const DEFAULT_CENTER: [number, number] = [50, 10];

const hasCoordinates = hasRadioCoordinates;

function project(lat: number, lon: number, zoom: number): [number, number] {
  const scale = TILE_SIZE * 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = (lon + 180) / 360 * scale;
  const sin = Math.sin(clampedLat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function unproject(x: number, y: number, zoom: number): [number, number] {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  const lat = 180 / Math.PI * Math.atan(Math.sinh(n));
  return [lat, lon];
}

@customElement('meshcore-map-page')
export class MapPage extends LitElement {
  @property({ type: Object }) hass?: HomeAssistant;
  @property({ type: Object }) config?: PanelConfig;
  @property({ type: Array }) contacts: Contact[] = [];
  @property({ type: Boolean }) narrow = false;
  @property({ type: String }) devicePrefix = '';

  @state() private _selectedKey: string | null = null;
  @state() private _center: [number, number] = DEFAULT_CENTER;
  @state() private _zoom = 5;
  @state() private _mapSize = { width: 0, height: 0 };
  @state() private _deviceSearch = '';
  @state() private _deviceSort: 'name' | 'activity' = 'name';
  @state() private _activityNow = Date.now();
  @state() private _messageMap: MessageMapState | null = null;
  @state() private _rawRadioRows: RawRadioRow[] = [];
  @state() private _selectedRadioRowId: number | null = null;
  @state() private _graphEdges: GraphEdge[] = [];
  private _rawRadioRowId = 0;
  private _graphAnimationFrame?: number;
  private _graphRefreshToken = 0;
  private static readonly GRAPH_TTL_MS = 5 * 60 * 1000;

  private _mapEl?: HTMLElement;
  private _resizeObserver?: ResizeObserver;
  private _dragging = false;
  private _dragStart = { x: 0, y: 0 };
  private _dragCenterPx = { x: 0, y: 0 };
  private _panVisual = { x: 0, y: 0 };
  private _activityTimer?: number;
  private _messageUnsubscribers: Array<() => void> = [];
  private _messageSubscriptionsActive = false;
  private _tilePreloadCache = new Map<string, HTMLImageElement>();
  private _tileTransition?: TileTransition;
  private _tileTransitionTimer?: number;
  private _panAnimationFrame?: number;
  /** Reception time of the latest advert heard for each node, keyed by public-key prefix. */
  private _liveLastAdvert = new Map<string, number>();
  /** Keep the raw latest radio packet so a contact refresh can resolve its path later. */
  private _latestRadioRx: Record<string, unknown> | null = null;
  /** Keep the raw RX_LOG_DATA envelope so a route can be rebuilt when contacts/coordinates arrive later. */
  private _latestRadioEventData: Record<string, unknown> | null = null;

  static styles = css`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      background: var(--primary-background-color, #fafafa);
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    .sidebar {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      background: var(--card-background-color, #fff);
      border-right: 1px solid var(--divider-color, #e0e0e0);
      z-index: 3;
    }

    .sidebar-header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
      color: var(--primary-text-color);
      font-size: 14px;
      font-weight: 600;
      flex-shrink: 0;
    }

    .sidebar-header small {
      display: block;
      margin-top: 3px;
      color: var(--secondary-text-color);
      font-size: 11px;
      font-weight: 400;
    }

    .device-search {
      padding: 8px 10px;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
      flex-shrink: 0;
    }

    .device-search input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 7px;
      background: var(--primary-background-color, #fafafa);
      color: var(--primary-text-color);
      font: inherit;
      font-size: 13px;
      outline: none;
    }

    .device-search input:focus {
      border-color: var(--primary-color, #03a9f4);
      box-shadow: 0 0 0 1px var(--primary-color, #03a9f4);
    }

    .activity {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 8px;
      font-weight: 700;
      line-height: 1;
      text-align: center;
      box-sizing: border-box;
      border: 1px solid rgba(255, 255, 255, .7);
      box-shadow: 0 1px 3px rgba(0, 0, 0, .22);
      font-variant-numeric: tabular-nums;
    }

    .activity {
      --activity-hue: 0;
      --activity-sat: 65%;
      --activity-light: 46%;
      background: hsl(var(--activity-hue) var(--activity-sat) var(--activity-light));
    }

    .activity.green { --activity-hue: 142; }
    .activity.yellow { --activity-hue: 45; }
    .activity.red { --activity-hue: 0; }
    .activity.gray {
      --activity-hue: 0;
      --activity-sat: 0%;
      --activity-light: 52%;
    }

    .node.no-location .activity {
      opacity: .55;
    }

    .sort-select {
      padding: 8px 10px;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
      flex-shrink: 0;
    }

    .sort-select select {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 9px;
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 7px;
      background: var(--primary-background-color, #fafafa);
      color: var(--primary-text-color);
      font: inherit;
      font-size: 12px;
    }
    .map-area { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
    .radio-table { flex: 0 0 25%; min-height: 120px; overflow: auto; border-top: 1px solid var(--divider-color, #e0e0e0); background: var(--card-background-color, #fff); }
    .radio-table table { width: 100%; border-collapse: collapse; font-size: 11px; white-space: nowrap; }
    .radio-table th { position: sticky; top: 0; z-index: 1; padding: 6px 8px; text-align: left; background: var(--secondary-background-color, #f5f5f5); color: var(--secondary-text-color); border-bottom: 1px solid var(--divider-color, #e0e0e0); font-weight: 600; }
    .radio-table td { padding: 5px 8px; border-bottom: 1px solid var(--divider-color, #e0e0e0); color: var(--primary-text-color); vertical-align: top; }
    .radio-table tr { cursor: pointer; }
    .radio-table tr:hover td { background: rgba(3, 169, 244, .05); }
    .radio-table tr.latest td { background: rgba(3, 169, 244, .08); }
    .radio-table tr.selected td { background: rgba(3, 169, 244, .16); }
    .radio-table .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .radio-table .muted { color: var(--secondary-text-color); }
    .radio-table-empty { padding: 12px; color: var(--secondary-text-color); font-size: 12px; }

    .node-list {
      overflow-y: auto;
      min-height: 0;
      flex: 1;
    }

    .node {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 10px 12px;
      border: 0;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
      background: transparent;
      color: var(--primary-text-color);
      text-align: left;
      font: inherit;
      cursor: pointer;
      box-sizing: border-box;
    }

    .node:hover:not(:disabled) {
      background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
    }

    .node.active {
      background: rgba(3, 169, 244, 0.12);
    }

    .node:disabled {
      cursor: default;
      opacity: 0.42;
    }

    .marker-preview {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--primary-color, #03a9f4);
      box-shadow: 0 0 0 3px rgba(3, 169, 244, 0.20);
      flex: 0 0 auto;
    }

    .node.no-location .marker-preview {
      background: var(--secondary-text-color, #777);
      box-shadow: none;
    }

    .node-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
    }

    .node-prefix {
      display: block;
      margin-top: 2px;
      color: var(--secondary-text-color);
      font-size: 10px;
    }

    .map {
      flex: 1 1 0;
      position: relative;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: #dfe7ec;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }

    .map.dragging {
      cursor: grabbing;
    }

    .map-content {
      position: absolute;
      inset: 0;
      will-change: transform;
    }

    .tiles {
      position: absolute;
      inset: 0;
      overflow: hidden;
      transform-origin: 50% 50%;
      will-change: transform;
    }

    .tiles.transition {
      z-index: 0;
      pointer-events: none;
      transition: transform 280ms cubic-bezier(.22, .61, .36, 1), opacity 280ms ease;
      transform-origin: 50% 50%;
    }

    .tiles.current {
      z-index: 1;
      pointer-events: none;
      animation: tile-fade-in 280ms ease;
    }

    @keyframes tile-fade-in {
      from { opacity: .25; }
      to { opacity: 1; }
    }

    .tile {
      position: absolute;
      width: ${TILE_SIZE}px;
      height: ${TILE_SIZE}px;
      max-width: none;
      pointer-events: none;
      image-rendering: auto;
      user-select: none;
    }

    .marker-layer {
      position: absolute;
      inset: 0;
      z-index: 3;
      pointer-events: none;
    }

    .label-layer {
      position: absolute;
      inset: 0;
      z-index: 4;
      pointer-events: none;
      overflow: visible;
    }
    .graph-layer {
      position: absolute;
      inset: 0;
      z-index: 5;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    }
    .graph-edge { fill: none; stroke: rgba(3,169,244,.55); stroke-width: 2; stroke-linecap: round; transition: opacity 300ms ease, stroke-width 300ms ease; }
    .graph-edge.active { stroke: rgba(3,169,244,.9); }
    .graph-node { fill: var(--card-background-color,#fff); stroke: rgba(3,169,244,.9); stroke-width: 2; }
    .graph-arrow { fill: rgba(3,169,244,.9); }
    .graph-node-group { pointer-events: none; }
    .graph-node-label { fill: var(--primary-text-color,#222); font-size: 11px; font-weight: 600; paint-order: stroke; stroke: var(--card-background-color,#fff); stroke-width: 3px; stroke-linejoin: round; }
    .graph-packet { fill: #fff; stroke: rgba(3,169,244,.98); stroke-width: 2; filter: drop-shadow(0 0 5px rgba(3,169,244,.9)); }

    .marker {
      position: absolute;
      width: 18px;
      height: 18px;
      border: 2px solid #fff;
      border-radius: 50% 50% 50% 0;
      background: var(--primary-color, #03a9f4);
      box-shadow: 0 1px 5px rgba(0, 0, 0, .35);
      transform: translate(-50%, -50%) rotate(-45deg);
      pointer-events: auto;
      cursor: pointer;
      padding: 0;
    }

    .activity-marker {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      border: 2px solid #fff;
      background: hsl(var(--activity-hue, 0) var(--activity-sat, 65%) var(--activity-light, 46%));
      transform: translate(-50%, -50%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 7px;
      font-weight: 700;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      letter-spacing: -.2px;
      text-shadow: 0 1px 2px rgba(0, 0, 0, .45);
      box-shadow: 0 1px 5px rgba(0, 0, 0, .35);
      padding: 0;
      box-sizing: border-box;
    }

    .activity-marker > span {
      display: block;
      white-space: nowrap;
      overflow: hidden;
      max-width: 100%;
    }

    .activity-marker.selected {
      width: 44px;
      height: 44px;
    }

    .node-label {
      position: absolute;
      transform: translate(10px, -50%) scale(var(--label-scale, 1));
      transform-origin: left center;
      max-width: 180px;
      padding: 2px 6px;
      border-radius: 5px;
      background: rgba(255, 255, 255, .88);
      color: #222;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .22);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      user-select: none;
    }

    .activity-marker.green { --activity-hue: 142; }
    .activity-marker.yellow { --activity-hue: 45; }
    .activity-marker.red { --activity-hue: 0; }
    .activity-marker.gray {
      --activity-hue: 0;
      --activity-sat: 0%;
      --activity-light: 52%;
    }

    .marker::after {
      content: '';
      position: absolute;
      width: 5px;
      height: 5px;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: #fff;
    }

    .activity-marker::after {
      display: none;
    }

    .controls {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      z-index: 4;
    }

    .controls button {
      width: 36px;
      height: 36px;
      border: 1px solid var(--divider-color, #ccc);
      border-radius: 7px;
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color);
      font-size: 20px;
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .18);
    }

    .controls button:hover {
      background: var(--secondary-background-color, #f5f5f5);
    }

    .empty-map {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--secondary-text-color);
      text-align: center;
      padding: 24px;
      pointer-events: none;
    }

    .attribution {
      position: absolute;
      right: 4px;
      bottom: 3px;
      z-index: 4;
      padding: 1px 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, .75);
      color: #444;
      font-size: 10px;
    }

    @media (max-width: 650px) {
      .layout {
        grid-template-columns: minmax(160px, 42%) minmax(0, 1fr);
      }
      .sidebar-header small {
        display: none;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._messageSubscriptionsActive = true;
    this._setupMessageSubscriptions();
    this._activityTimer = window.setInterval(() => {
      this._activityNow = Date.now();
    }, 30_000);
    this._resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      this._mapSize = { width, height };
      if (this._graphEdges.length) {
        this._fitGraph();
      } else {
        this._fitAll();
      }
    });
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    this._removePointerListeners();
    if (this._tileTransitionTimer !== undefined) {
      window.clearTimeout(this._tileTransitionTimer);
      this._tileTransitionTimer = undefined;
    }
    this._messageSubscriptionsActive = false;
    this._teardownMessageSubscriptions();
    if (this._graphAnimationFrame !== undefined) { window.cancelAnimationFrame(this._graphAnimationFrame); this._graphAnimationFrame = undefined; }
    if (this._activityTimer !== undefined) {
      window.clearInterval(this._activityTimer);
      this._activityTimer = undefined;
    }
    this._tilePreloadCache.clear();
    if (this._panAnimationFrame !== undefined) {
      window.cancelAnimationFrame(this._panAnimationFrame);
      this._panAnimationFrame = undefined;
    }
    super.disconnectedCallback();
  }

  protected firstUpdated() {
    this._mapEl = this.shadowRoot?.querySelector('.map') as HTMLElement | undefined;
    if (this._mapEl) {
      this._resizeObserver?.observe(this._mapEl);
    }
    this._fitAll();
  }


  private get _nodes(): MapNode[] {
    return this.contacts
      .map(contact => ({ contact, coords: nodeCoordinates(contact) }))
      .filter((item): item is { contact: Contact; coords: { lat: number; lon: number } } => item.coords !== null)
      .map(item => ({ contact: item.contact, lat: item.coords.lat, lon: item.coords.lon }));
  }

  private _name(contact: Contact): string {
    return contact.adv_name || contact.pubkey_prefix || 'Unknown node';
  }

  private _activity(contact: Contact): { className: string; label: string; title: string; style?: string } {
    // Keep the map activity indicator consistent with Nodes → Last Heard.
    // The Nodes page displays Contact.last_advert, so the map must use the
    // same timestamp rather than the local contact-store lastmod value.
    const publicKey = String(contact.public_key || '').toLowerCase();
    const prefix = String(contact.pubkey_prefix || '').toLowerCase();
    const liveTimestamp = [publicKey, prefix]
      .map(key => key ? this._liveLastAdvert.get(key) || 0 : 0)
      .reduce((max, value) => Math.max(max, value), 0);
    const timestamp = Math.max(Number(contact.last_advert) || 0, liveTimestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return { className: 'gray', label: '—', title: 'No activity timestamp' };
    }

    const advertMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    const ageMs = Math.max(0, this._activityNow - advertMs);
    const ageMinutes = Math.floor(ageMs / 60_000);

    let className: string;
    let style: string | undefined;
    if (ageMs < 60 * 60_000) {
      className = 'green';
      const progress = ageMs / (60 * 60_000);
      style = `--activity-hue:${Math.round(142 - 97 * progress)}`;
    } else if (ageMs < 3 * 60 * 60_000) {
      className = 'yellow';
      const progress = (ageMs - 60 * 60_000) / (2 * 60 * 60_000);
      style = `--activity-hue:${Math.round(45 - 45 * progress)}`;
    } else if (ageMs < 24 * 60 * 60_000) {
      className = 'red';
      const progress = (ageMs - 3 * 60 * 60_000) / (21 * 60 * 60_000);
      style = `--activity-light:${Math.round(46 - 10 * progress)}%`;
    } else {
      className = 'gray';
    }

    let label: string;
    if (ageMinutes < 1) label = '<1m';
    else if (ageMinutes < 60) label = `${ageMinutes}m`;
    else if (ageMinutes < 24 * 60) label = `${Math.floor(ageMinutes / 60)}h`;
    else label = `${Math.floor(ageMinutes / (24 * 60))}d`;

    const title = label === '<1m'
      ? 'Last heard less than 1 minute ago'
      : `Last heard: ${label} ago`;

    return { className, label, title, style };
  }

  private _eventBelongsToDevice(data: Record<string, unknown>): boolean {
    const prefix = this.devicePrefix.trim().toLowerCase().replace(/[^0-9a-f]/g, '').substring(0, 6);
    if (!prefix) return true;
    const entryId = String(data.entry_id || '');
    if (this.config?.entry_id && entryId) return entryId === this.config.entry_id;
    const entityId = String(data.entity_id || '').toLowerCase();
    if (!entityId) return true;
    return entityId.includes(`meshcore_${prefix}_`);
  }

  private _debugRadioEvent(kind: string, data: Record<string, unknown>, extra?: Record<string, unknown>) {
    console.debug('[MeshCore Chat]', kind, {
      event: data,
      ...extra,
    });
  }

  private _rawNumber(value: unknown, suffix = ''): string {
    if (value === undefined || value === null || value === '') return '—';
    const number = Number(value);
    return Number.isFinite(number) ? String(number) + suffix : String(value);
  }

  private _rawPayloadLength(source: Record<string, unknown>): number | null {
    // MeshCore reports the packet payload size under several key spellings.
    const keys = ['payload_length', 'payload_len', 'packet_len', 'pkt_len', 'length'];
    for (const key of keys) {
      if (!(key in source)) continue;
      const value = source[key];
      if (value === undefined || value === null || value === '') continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return null;
  }

  private _extractRadioMessage(...sources: Array<Record<string, unknown> | undefined>): string | undefined {
    const keys = ['message', 'text', 'message_text', 'msg', 'content'];
    const seen = new Set<Record<string, unknown>>();

    const visit = (source?: Record<string, unknown>): string | undefined => {
      if (!source || seen.has(source)) return undefined;
      seen.add(source);

      for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value;
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      }

      // MeshCore adapters can put decoded text under parsed/decrypted/payload.
      for (const key of ['parsed', 'decrypted', 'payload']) {
        const nested = source[key];
        if (nested && typeof nested === 'object') {
          const value = visit(nested as Record<string, unknown>);
          if (value) return value;
        }
      }
      return undefined;
    };

    for (const source of sources) {
      const value = visit(source);
      if (value) return value;
    }
    return undefined;
  }

  private _recordRawRadioEvent(data: Record<string, unknown>, rx?: Record<string, unknown>) {
    const payload = rx || (data.payload && typeof data.payload === 'object' ? data.payload as Record<string, unknown> : undefined);
    const source = payload || data;

    // Filter out every event whose payload_length is empty/absent — those are
    // non-informative radio rows (keep-alives, incomplete log records) that
    // only add noise to the RAW_EVENT table below the map.
    const payloadLength = this._rawPayloadLength(source) ?? this._rawPayloadLength(data);
    if (payloadLength === null || payloadLength <= 0) return;

    const hashes = payload ? this._pathHashes(payload) : [];
    const type = String(source.payload_typename || source.payload_type || data.event_type || 'UNKNOWN').replace(/^EventType\./, '');
    const route = String(source.route_typename || '—');
    const rawMessage = this._extractRadioMessage(source, data);
    const message = rawMessage || '—';
    const snr = source.snr; const rssi = source.rssi;
    const noise = source.noise ?? source.noise_floor ?? source.noise_dbm;
    const telemetryKeys = /^(freq|frequency|bandwidth|bw|sf|spreading_factor|coding_rate|cr|tx_power|channel|payload_length|packet_len|pkt_hash|header)$/i;
    const telemetryEntries = Object.entries(source).filter(([key, value]) => value !== undefined && value !== null && value !== '' && telemetryKeys.test(key)).map(([key, value]) => key + '=' + String(value));
    const timestamp = Number(data.timestamp ?? source.recv_time);
    const date = Number.isFinite(timestamp) ? new Date(timestamp < 10000000000 ? timestamp * 1000 : timestamp) : new Date();
    const row: RawRadioRow = {
      id: ++this._rawRadioRowId, time: date.toLocaleTimeString(), type, route,
      path: hashes.length ? hashes.join(' → ') : '—',
      message,
      coordinates: this._routeCoordinateStatus(hashes),
      snr: this._rawNumber(snr, snr !== undefined ? ' dB' : ''),
      rssi: this._rawNumber(rssi, rssi !== undefined ? ' dBm' : ''),
      noise: this._rawNumber(noise, noise !== undefined ? ' dBm' : ''),
      telemetry: telemetryEntries.length ? telemetryEntries.join(' · ') : '—',
      hashes,
      payloadType: Number.isFinite(Number(source.payload_type)) ? Number(source.payload_type) : undefined,
      payloadName: type,
      eventData: { ...data },
      rxData: payload ? { ...payload } : undefined,
    };
    this._rawRadioRows = [row, ...this._rawRadioRows].slice(0, 100);
  }

  private _showRadioRow(row: RawRadioRow) {
    this._selectedRadioRowId = row.id;

    if (row.eventData && row.rxData) {
      this._latestRadioEventData = { ...row.eventData };
      this._latestRadioRx = { ...row.rxData };
      // History uses exactly the same technical graph and animation as a live packet.
      this._recordFloodGraph(row.eventData, row.rxData);
      this._messageMap = null;
      if (this._graphEdges.length) void this._refreshGraphView('RAW_EVENT row');
      return;
    }

    this._messageMap = null;
    this._graphEdges = this._buildGraphEdges(row.hashes, row.snr, row.rssi);
    if (this._graphEdges.length) {
      void this._refreshGraphView('RAW_EVENT row');
    }
  }

  private _buildGraphEdges(
    hashes: string[],
    snrValue?: string | number,
    rssiValue?: string | number,
    extraPoint?: MessageMapPoint,
  ): GraphEdge[] {
    if (hashes.length < 1 && !extraPoint) return [];
    // For ADVERT/FLOOD the advertised node is not part of the path hash
    // list, but its coordinates are a real geographic anchor. Pass it into
    // path resolution before filtering unresolved hops so missing contacts
    // can be interpolated/extrapolated instead of collapsing the route.
    const points = this._resolvePathPoints(
      hashes,
      extraPoint && Number.isFinite(extraPoint.lat) && Number.isFinite(extraPoint.lon)
        ? [extraPoint]
        : undefined,
    );
    if (extraPoint && Number.isFinite(extraPoint.lat) && Number.isFinite(extraPoint.lon)) {
      if (!points.length || points[points.length - 1].key !== extraPoint.key) {
        points.push(extraPoint);
      }
    }
    if (points.length < 2) return [];
    const now = performance.now();
    const wallNow = Date.now();
    const snr = Number(snrValue);
    const rssi = Number(rssiValue);
    const edges: GraphEdge[] = [];

    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i];
      const to = points[i + 1];
      if (!from || !to || from.key === to.key) continue;
      edges.push({
        id: `${from.key}|${to.key}`,
        from,
        to,
        count: 1,
        lastSeen: wallNow,
        flowStartedAt: now,
        snr: Number.isFinite(snr) ? snr : undefined,
        rssi: Number.isFinite(rssi) ? rssi : undefined,
      });
    }
    return edges;
  }

  private _routeCoordinateStatus(hashes: string[]): string {
    if (!hashes.length) return '—';
    const located = hashes.reduce((count, hash) => {
      const contact = this._findContactByHash(hash);
      return count + (contact && hasCoordinates(contact) ? 1 : 0);
    }, 0);
    if (located >= 2) {
      const missing = hashes.length - located;
      return missing ? `✓ ${located}/${hashes.length} (интерполяция ${missing})` : `✓ ${located}/${hashes.length}`;
    }
    return `✗ ${located}/${hashes.length}`;
  }

  private _recordFloodGraph(data: Record<string, unknown>, rx?: Record<string, unknown>) {
    const source = rx || data;
    const payloadType = Number(source.payload_type ?? data.payloadType);
    const payloadName = String(source.payload_typename ?? data.payloadTypeName ?? '').replace(/^EventType\./i, '').toUpperCase();

    // Every RX_LOG_DATA packet with a path gets the same technical route
    // graph, including TEXT_MSG / GRP_TXT. Text packets additionally get their
    // message bubble below; the graph must not depend on the payload type.
    const routeType = String(source.route_typename ?? source.routeType ?? data.routeType ?? '')
      .replace(/^EventType\./i, '').toUpperCase();

    const sourceHashes = this._pathHashes(source);
    const hashes = sourceHashes.length ? sourceHashes : this._pathHashes(data);

    // For FLOOD ADVERT packets the path contains forwarding hops, while the
    // advertised node itself is the packet endpoint. Include its advertised
    // coordinates as the final graph vertex so the complete route is visible.
    let advertPoint: MessageMapPoint | undefined;
    if (payloadType === 4) {
      const advKey = String(source.adv_key || data.adv_key || '').toLowerCase().replace(/[^0-9a-f]/g, '');
      const advName = String(source.adv_name || data.adv_name || 'Advertised node');
      const advLat = Number(source.adv_lat ?? data.adv_lat);
      const advLon = Number(source.adv_lon ?? data.adv_lon);
      const normalizedLat = Number.isInteger(advLat) && Math.abs(advLat) > 180 ? advLat / 1e6 : advLat;
      const normalizedLon = Number.isInteger(advLon) && Math.abs(advLon) > 180 ? advLon / 1e6 : advLon;
      if (Number.isFinite(normalizedLat) && Number.isFinite(normalizedLon)
        && Math.abs(normalizedLat) <= 90 && Math.abs(normalizedLon) <= 180
        && !(normalizedLat === 0 && normalizedLon === 0)) {
        advertPoint = {
          key: advKey || `advert:${advName}`,
          name: advName,
          lat: normalizedLat,
          lon: normalizedLon,
        };
      }
    }

    const graphEdges = this._buildGraphEdges(
      hashes,
      typeof source.snr === 'string' || typeof source.snr === 'number' ? source.snr : (typeof data.snr === 'string' || typeof data.snr === 'number' ? data.snr : undefined),
      typeof source.rssi === 'string' || typeof source.rssi === 'number' ? source.rssi : (typeof data.rssi === 'string' || typeof data.rssi === 'number' ? data.rssi : undefined),
      advertPoint,
    );
    this._graphEdges = graphEdges;
    if (graphEdges.length) {
      void this._refreshGraphView('RX_LOG_DATA');
    }
    this._debugRadioEvent('RADIO route graph built', data, {
      payloadType,
      payloadName,
      routeType,
      hashes,
      resolved: graphEdges.flatMap(edge => [edge.from.name, edge.to.name]),
      resolvedPoints: graphEdges.flatMap(edge => [
        { name: edge.from.name, lat: edge.from.lat, lon: edge.from.lon },
        { name: edge.to.name, lat: edge.to.lat, lon: edge.to.lon },
      ]),
      edgeCount: graphEdges.length,
    });
  }

  private async _refreshGraphView(reason: string) {
    const refreshToken = ++this._graphRefreshToken;
    if (!this._graphEdges.length) return;

    // Graph geometry depends on the actual rendered map viewport. Wait for
    // Lit first, then refresh the size directly as a fallback because the
    // ResizeObserver callback can lag behind the first RX_LOG_DATA render.
    await this.updateComplete;
    if (refreshToken !== this._graphRefreshToken || !this._graphEdges.length) return;

    if (!this._mapSize.width || !this._mapSize.height) {
      const map = this._mapEl || this.shadowRoot?.querySelector('.map') as HTMLElement | null;
      const rect = map?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        this._mapSize = { width: rect.width, height: rect.height };
        await this.updateComplete;
      } else {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (refreshToken !== this._graphRefreshToken || !this._graphEdges.length) return;
      }
    }

    if (!this._mapSize.width || !this._mapSize.height) return;

    // Fit after the graph layer exists and the map dimensions are known.
    // _fitGraph updates center/zoom, so wait for that render before starting
    // the packet animation.
    this._fitGraph();
    await this.updateComplete;
    if (refreshToken !== this._graphRefreshToken || !this._graphEdges.length) return;

    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (refreshToken !== this._graphRefreshToken || !this._graphEdges.length) return;

    this._startGraphAnimation();

    this._debugRadioEvent('RADIO graph view refreshed', {
      reason,
      graphEdgeCount: this._graphEdges.length,
    }, {
      mapSize: this._mapSize,
      center: this._center,
      zoom: this._zoom,
      graphLayerRendered: Boolean(this.shadowRoot?.querySelector('.graph-layer')),
      edges: this._graphEdges.map(edge => ({
        from: { name: edge.from.name, lat: edge.from.lat, lon: edge.from.lon },
        to: { name: edge.to.name, lat: edge.to.lat, lon: edge.to.lon },
      })),
    });
  }

  private _fitGraph() {
    const unique = new Map(this._graphEdges.flatMap(edge => [edge.from, edge.to]).map(point => [point.key, point]));
    // BUG-9: invalid coordinates must never reach fitBounds — they collapse
    // the computed span and force a full-world zoom-out.
    const nodes = [...unique.values()]
      .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    if (nodes.length === 0) return;
    const minLat = Math.min(...nodes.map(point => point.lat));
    const maxLat = Math.max(...nodes.map(point => point.lat));
    const minLon = Math.min(...nodes.map(point => point.lon));
    const maxLon = Math.max(...nodes.map(point => point.lon));
    this._center = [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
    if (nodes.length === 1 || (minLat === maxLat && minLon === maxLon)) {
      this._zoom = 12;
      return;
    }
    // Fit the route against the actual drawable area with a modest pixel margin.
    // The previous implementation reserved 140px and then dropped one more
    // zoom level, which made short/medium routes appear unnecessarily tiny.
    const width = Math.max(this._mapSize.width - 80, 320);
    const height = Math.max(this._mapSize.height - 80, 240);
    let best = MIN_ZOOM;
    for (let z = MAX_ZOOM; z >= MIN_ZOOM; z -= 1) {
      const [x1, y1] = project(minLat, minLon, z);
      const [x2, y2] = project(maxLat, maxLon, z);
      if (Math.abs(x2 - x1) <= width && Math.abs(y2 - y1) <= height) {
        best = z;
        break;
      }
    }
    // Use the highest level that fits. The 40px border on each side is
    // enough for arrowheads/labels while keeping the route visually large.
    this._zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, best));
  }

  /**
   * Lit reliably creates the graph SVG, but some browsers can retain stale
   * SVG geometry after a map viewport update. Re-apply the graph geometry
   * directly to the rendered SVG, using the same route layer.
   */
  private _wireGraphLayer() {
    const root = this.shadowRoot;
    if (!root || !this._graphEdges.length) return;

    const layer = root.querySelector('svg.graph-layer') as SVGSVGElement | null;
    if (!layer) return;

    const svgNamespace = 'http://www.w3.org/2000/svg';

    // The technical graph is rendered from the normal Lit html template.
    // Some WebViews/bundles have produced HTML-namespace descendants inside
    // that SVG. Browsers then keep the nodes in the DOM but do not paint
    // their SVG geometry. Normalize every descendant before setting geometry.
    const convertToSvg = (source: Element): Element => {
      if (source.namespaceURI === svgNamespace) {
        for (const child of Array.from(source.children)) convertToSvg(child);
        return source;
      }
      const target = document.createElementNS(svgNamespace, source.tagName.toLowerCase());
      Array.from(source.attributes).forEach(attribute => {
        target.setAttribute(attribute.name, attribute.value);
      });
      while (source.firstChild) {
        const child = source.firstChild;
        if (child.nodeType === Node.ELEMENT_NODE) {
          target.appendChild(convertToSvg(child as Element));
        } else {
          target.appendChild(child);
        }
      }
      source.replaceWith(target);
      return target;
    };

    for (const child of Array.from(layer.children)) convertToSvg(child);
    layer.setAttribute('xmlns', svgNamespace);
    layer.style.display = 'block';
    layer.style.position = 'absolute';
    layer.style.zIndex = '5';
    layer.style.pointerEvents = 'none';

    const width = Math.max(1, this._mapSize.width);
    const height = Math.max(1, this._mapSize.height);
    layer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    layer.setAttribute('width', String(width));
    layer.setAttribute('height', String(height));

    const defs = layer.querySelector('defs');
    const marker = defs?.querySelector('#graph-arrow');
    if (marker) {
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '8');
      marker.setAttribute('refX', '7');
      marker.setAttribute('refY', '3.5');
      marker.setAttribute('orient', 'auto');
      marker.setAttribute('markerUnits', 'strokeWidth');
    }

    const edgesById = new Map(this._graphEdges.map(edge => [edge.id, edge]));
    root.querySelectorAll<SVGLineElement>('svg.graph-layer line.graph-edge').forEach(line => {
      const id = line.getAttribute('data-graph-edge');
      const edge = id ? edgesById.get(id) : undefined;
      if (!edge) return;
      const from = this._mapPoint(edge.from.lat, edge.from.lon);
      const to = this._mapPoint(edge.to.lat, edge.to.lon);
      if (![from.left, from.top, to.left, to.top].every(Number.isFinite)) return;
      line.setAttribute('x1', String(from.left));
      line.setAttribute('y1', String(from.top));
      line.setAttribute('x2', String(to.left));
      line.setAttribute('y2', String(to.top));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', 'rgba(3,169,244,.9)');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('marker-end', 'url(#graph-arrow)');
    });

    const points = new Map<string, MessageMapPoint>();
    for (const edge of this._graphEdges) {
      points.set(edge.from.key, edge.from);
      points.set(edge.to.key, edge.to);
    }

    root.querySelectorAll<SVGCircleElement>('svg.graph-layer circle.graph-node').forEach(node => {
      const key = node.getAttribute('data-graph-node');
      const point = key ? points.get(key) : undefined;
      if (!point) return;
      const pos = this._mapPoint(point.lat, point.lon);
      if (![pos.left, pos.top].every(Number.isFinite)) return;
      node.setAttribute('cx', String(pos.left));
      node.setAttribute('cy', String(pos.top));
      node.setAttribute('fill', 'var(--card-background-color,#fff)');
      node.setAttribute('stroke', 'rgba(3,169,244,.9)');
      node.setAttribute('stroke-width', '2');
    });

    root.querySelectorAll<SVGTextElement>('svg.graph-layer text.graph-node-label').forEach(label => {
      const key = label.getAttribute('data-graph-node-label');
      const point = key ? points.get(key) : undefined;
      if (!point) return;
      const pos = this._mapPoint(point.lat, point.lon);
      if (![pos.left, pos.top].every(Number.isFinite)) return;
      label.setAttribute('x', String(pos.left + 10));
      label.setAttribute('y', String(pos.top - 10));
    });

    root.querySelectorAll<SVGCircleElement>('svg.graph-layer circle.graph-packet').forEach(packet => {
      const key = packet.getAttribute('data-graph-packet');
      const edge = key
        ? this._graphEdges.find(candidate => candidate.id.replace(/[^a-zA-Z0-9_-]/g, '_') === key)
        : undefined;
      if (!edge) return;
      const pos = this._mapPoint(edge.from.lat, edge.from.lon);
      if (![pos.left, pos.top].every(Number.isFinite)) return;
      packet.setAttribute('cx', String(pos.left));
      packet.setAttribute('cy', String(pos.top));
      packet.setAttribute('fill', '#fff');
      packet.setAttribute('stroke', 'rgba(3,169,244,.98)');
      packet.setAttribute('stroke-width', '2');
    });
  }

  private _startGraphAnimation() {
    if (this._graphAnimationFrame === undefined) this._graphAnimationFrame = window.requestAnimationFrame(this._animateGraph);
  }

  private _animateGraph = (now: number) => {
    this._graphAnimationFrame = undefined;
    const live = this._graphEdges.filter(edge => Date.now() - edge.lastSeen < MapPage.GRAPH_TTL_MS);
    if (live.length !== this._graphEdges.length) this._graphEdges = live;
    if (!live.length) return;
    const layer = this.shadowRoot?.querySelector('.graph-layer');
    if (!layer) { this._graphAnimationFrame = window.requestAnimationFrame(this._animateGraph); return; }
    for (const edge of live) {
      const key = edge.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const packet = layer.querySelector('[data-graph-packet="' + key + '"]') as SVGCircleElement | null;
      if (!packet) continue;
      const start = this._mapPoint(edge.from.lat, edge.from.lon); const end = this._mapPoint(edge.to.lat, edge.to.lon);
      const duration = Math.max(900, Math.min(3200, 1400 + Math.hypot(end.left - start.left, end.top - start.top) * 2));
      const progress = ((now - edge.flowStartedAt) % duration) / duration;
      packet.setAttribute('cx', String(start.left + (end.left - start.left) * progress));
      packet.setAttribute('cy', String(start.top + (end.top - start.top) * progress));
    }
    this._graphAnimationFrame = window.requestAnimationFrame(this._animateGraph);
  };
  private _setupMessageSubscriptions() {
    this._teardownMessageSubscriptions();
    if (!this._messageSubscriptionsActive || !this.hass?.connection?.subscribeEvents) return;
    const subscribe = async (eventType: string, handler: (data: Record<string, unknown>) => void) => {
      try {
        const unsubscribe = await this.hass!.connection.subscribeEvents(
          (event: { data?: Record<string, unknown> }) => { if (event.data) handler(event.data); },
          eventType,
        );
        if (!this._messageSubscriptionsActive) { unsubscribe(); return; }
        this._messageUnsubscribers.push(unsubscribe);
      } catch (_) { /* Older MeshCore versions may not expose this event. */ }
    };
    void subscribe('meshcore_message', data => {
      this._debugRadioEvent('MESSAGE received', data, {
        belongsToDevice: this._eventBelongsToDevice(data),
        rxLogData: data.rx_log_data,
      });
      if (!this._eventBelongsToDevice(data)) return;
      const messageMap = this._buildMessageMap(data);
      // meshcore_message can arrive immediately after RX_LOG_DATA for the
      // same packet. RX_LOG_DATA carries the full radio path while the
      // message event carries the readable text — and for DM packets the
      // message event has no rx_log_data at all (only hop_count/snr), so
      // its map degenerates to a single sender point. Compare route
      // *richness* (total resolved points), not the route count: both maps
      // usually contain exactly one route, and the old route-count check
      // replaced the full RX_LOG_DATA route with one sender point — which
      // broke the map route for every payload type that emits
      // meshcore_message (only GRP_TXT, which never emits the follow-up
      // event, kept its route).
      const currentPoints = this._messageMap
        ?.routes.reduce((sum, route) => sum + route.points.length, 0) ?? 0;
      const incomingPoints = messageMap.routes.reduce((sum, route) => sum + route.points.length, 0);
      if (!currentPoints || incomingPoints >= currentPoints) {
        this._messageMap = messageMap;
      } else {
        // Keep the richer RX_LOG_DATA route and adopt the readable message
        // metadata so the bubble shows the real text/sender/channel.
        const existing = this._messageMap!;
        this._messageMap = {
          ...existing,
          sender: messageMap.sender,
          target: messageMap.target,
          text: messageMap.text,
          channel: messageMap.channel,
          pubkeyPrefix: messageMap.pubkeyPrefix,
          timestamp: messageMap.timestamp,
        };
      }
      // meshcore_message normally arrives after RX_LOG_DATA. Its fitMessage()
      // can move the viewport away from the technical graph that was built
      // from the same radio packet. Keep the latest packet graph authoritative
      // for messages too, just like GRP_TXT packets that do not emit a later
      // meshcore_message event.
      if (this._graphEdges.length) void this._refreshGraphView('MESSAGE map built');
      this._debugRadioEvent('MESSAGE map built', data, {
        routes: this._messageMap.routes,
        routeCount: this._messageMap.routes.length,
        rxRoutes: messageMap.routes,
        rxRouteCount: messageMap.routes.length,
      });
    });
    void subscribe('meshcore_delivery_update', data => {
      this._debugRadioEvent('DELIVERY_UPDATE received', data, {
        belongsToDevice: this._eventBelongsToDevice(data),
        });
      if (!this._eventBelongsToDevice(data)) return;
      const current = this._messageMap;
      const text = String(data.message || '');
      const sender = String(data.sender_name || '');

      if (text) {
        const latestRow = this._rawRadioRows[0];
        if (latestRow && latestRow.message === '—') {
          this._rawRadioRows = [
            { ...latestRow, message: text },
            ...this._rawRadioRows.slice(1),
          ];
        }
      }
      if (!current) {
        if (!text) return;
        this._messageMap = this._buildMessageMap(data);
        if (this._graphEdges.length) void this._refreshGraphView('DELIVERY_UPDATE fallback');
        return;
      }
      if (text && current.text !== text) return;
      if (sender && current.sender !== sender) return;
      this._messageMap = this._buildMessageMap({
        ...data,
        sender_name: current.sender,
        message: current.text,
        channel: current.channel,
        pubkey_prefix: current.pubkeyPrefix,
        timestamp: current.timestamp,
      });
      if (this._graphEdges.length) void this._refreshGraphView('DELIVERY_UPDATE map built');
    });
    void subscribe('meshcore_raw_event', data => {
      const eventType = String(data.event_type || '').replace(/^EventType\./i, '').toUpperCase();
      const payload = data.payload;
      const rx = payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : undefined;

      const payloadTypeName = String(rx?.payload_typename || '').replace(/^EventType\./i, '').toUpperCase();
      if (eventType === 'NO_MORE_MSGS' || eventType === 'BATTERY' || payloadTypeName === 'NO_MORE_MSGS' || payloadTypeName === 'BATTERY') return;

      // Log every raw event type so the browser console shows exactly what
      // meshcore-ha is delivering to the panel. Advert-specific details are
      // logged separately below.
      this._recordRawRadioEvent(data, rx);
      if (eventType === 'RX_LOG_DATA' && rx) {
        // A newly received event always becomes the active route, replacing
        // any route that was selected manually from the history table.
        this._selectedRadioRowId = null;
        this._latestRadioEventData = { ...data };
        this._latestRadioRx = { ...rx, timestamp: data.timestamp };
        this._recordFloodGraph(data, rx);
      }

      this._debugRadioEvent('RAW_EVENT received', data, {
        eventType,
        payloadType: rx?.payload_type,
        pathHashSize: rx?.path_hash_size,
        pathLen: rx?.path_len,
        path: rx?.path,
        pathNodes: rx?.path_nodes,
        routeType: rx?.route_typename,
        advKey: rx?.adv_key,
        advName: rx?.adv_name,
        advLat: rx?.adv_lat,
        advLon: rx?.adv_lon,
        snr: rx?.snr,
        rssi: rx?.rssi,
      });

      if (eventType !== 'RX_LOG_DATA' || !rx) return;

      const payloadType = Number(rx.payload_type);
      const isTextPacket = payloadType === 2 || payloadType === 5 || payloadTypeName === 'TEXT_MSG' || payloadTypeName === 'GRP_TXT';
      if (payloadType === 4) {
        // A PUSH/advert packet is authoritative proof that this node was
        // heard now. Keep that reception time locally so the sidebar does
        // not lag behind Nodes until the next full contact sync.
        const advertKey = String(rx.adv_key || '').toLowerCase();
        const receivedAt = Number(rx.recv_time || data.timestamp || Date.now());
        const receivedMs = receivedAt > 10_000_000_000 ? receivedAt : receivedAt * 1000;
        if (advertKey && Number.isFinite(receivedMs) && receivedMs > 0) {
          this._liveLastAdvert.set(advertKey, receivedMs);
          this._liveLastAdvert.set(advertKey.substring(0, 12), receivedMs);
        }
        // The technical graph above is the only map visualization; keep advert metadata for diagnostics.
        const advertMap = this._buildAdvertMap({
          ...rx,
          timestamp: data.timestamp,
        });
        this._messageMap = advertMap;
        // An advert without resolvable coordinates must not keep stale route metadata.
        if (!advertMap.routes.length) {
          this._messageMap = null;
          if (this._graphEdges.length) void this._refreshGraphView('ADVERT');
        }

        this._debugRadioEvent('ADVERT received', data, {
          payloadType,
          name: advertMap.sender,
          target: advertMap.target,
          text: advertMap.text,
          timestamp: advertMap.timestamp,
          routes: advertMap.routes,
          routeCount: advertMap.routes.length,
          routeHashes: this._pathHashes(rx),
          pathHashSize: rx.path_hash_size,
          pathLen: rx.path_len,
        });
        return;
      }

      if (!isTextPacket) {
        // A non-text technical packet is rendered as the route graph only.
        // Drop any stale message bubble/route from a previous packet so the
        // two visualizations never overlap (BUG-13).
        this._messageMap = null;
        if (this._graphEdges.length) void this._refreshGraphView('technical packet');
        return;
      }

      // All other defined MeshCore payload types are rendered as radio
      // packet events. If a packet has a path, draw the resolvable hops;
      // if path_len=0 (for example DIRECT RESPONSE), keep the event visible.
      const packetMap = this._buildPacketMap({
        ...rx,
        timestamp: data.timestamp,
      });
      // Keep message metadata for diagnostics/table updates; the map itself uses the technical graph.
      // For non-text packets an unresolvable route must not keep stale metadata.
      if (packetMap.routes.length || isTextPacket) {
        this._messageMap = packetMap;
      } else {
        this._messageMap = null;
        if (this._graphEdges.length) void this._refreshGraphView('packet fallback');
      }

      this._debugRadioEvent('PACKET map built', data, {
        payloadType,
        payloadName: rx.payload_typename,
        name: packetMap.sender,
        target: packetMap.target,
        text: packetMap.text,
        timestamp: packetMap.timestamp,
        routes: packetMap.routes,
        routeCount: packetMap.routes.length,
        routeHashes: this._pathHashes(rx),
        pathHashSize: rx.path_hash_size,
        pathLen: rx.path_len,
      });
    });
  }

  protected updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (changedProperties.has('hass') || changedProperties.has('devicePrefix')) {
      this._setupMessageSubscriptions();
    }
    this._applyPanTransform();
    // Paint-server attributes (marker arrowheads, mpath motion refs) are set
    // imperatively after every render so the route arrows and packets can
    // never be lost to template/bundle quirks.
    this._wireGraphLayer();

    if (changedProperties.has('_graphEdges')) {
      this._startGraphAnimation();
    }

    if (changedProperties.has('contacts')) {
      const hadSelected = this._selectedKey && this.contacts.some(
        c => c.public_key === this._selectedKey && hasCoordinates(c),
      );
      if (!hadSelected) this._selectedKey = null;

      if (this._latestRadioEventData && this._latestRadioRx) {
        this._recordFloodGraph(this._latestRadioEventData, this._latestRadioRx);
      } else {
        this._fitAll();
      }
    }
  }

  private _teardownMessageSubscriptions() {
    this._messageUnsubscribers.forEach(unsubscribe => { try { unsubscribe(); } catch (_) {} });
    this._messageUnsubscribers = [];
  }

  private _findContactByHash(hash: string, excludeKeys?: Set<string>): Contact | undefined {
    const normalized = hash.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (!normalized) return undefined;

    const normalizeKey = (value: unknown) =>
      String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    const matches = this.contacts.filter(contact => {
      const key = normalizeKey(contact.public_key);
      const prefix = normalizeKey(contact.pubkey_prefix);
      // MeshCore path IDs are the first 1–3 bytes of the node public key.
      return key.startsWith(normalized) || prefix.startsWith(normalized);
    });
    if (!matches.length) return undefined;

    // One-byte path hashes can collide. When resolving one path, prefer a
    // different matching contact that has not already been used. This prevents
    // two consecutive hops from collapsing to the same vertex and dropping the
    // connecting edge.
    const available = excludeKeys?.size
      ? matches.filter(contact => !excludeKeys.has(normalizeKey(contact.public_key)))
      : matches;
    const candidates = available.length ? available : matches;
    if (candidates.length === 1) return candidates[0];

    const located = candidates.filter(hasCoordinates);
    if (located.length === 1) return located[0];
    return [...candidates].sort((a, b) =>
      (Number(b.lastmod) || Number(b.last_advert) || 0)
      - (Number(a.lastmod) || Number(a.last_advert) || 0),
    )[0];
  }

  private _pathHashes(rx: Record<string, unknown>): string[] {
    return parsePathHashes(rx);
  }

  private _resolvePathPoints(hashes: string[], extraAnchors?: MessageMapPoint[]): MessageMapPoint[] {
    if (!hashes.length) return [];

    // Keep the exact radio path order. A hash may resolve to a contact even
    // when that contact has no advertised coordinates; such a node must still
    // remain visible in the route graph.
    const usedContactKeys = new Set<string>();
    const points = hashes.map((hash, index) => {
      const contact = this._findContactByHash(hash, usedContactKeys);
      if (contact?.public_key) {
        usedContactKeys.add(String(contact.public_key).toLowerCase().replace(/[^0-9a-f]/g, ''));
      }
      const coords = contact ? nodeCoordinates(contact) : null;
      return {
        key: contact?.public_key || `path:${hash}:${index}`,
        name: contact ? this._name(contact) : hash,
        lat: coords ? coords.lat : Number.NaN,
        lon: coords ? coords.lon : Number.NaN,
      };
    });

    // A caller-provided located anchor (e.g. the message sender prepended in
    // front of the radio path) counts as a coordinate anchor too: with it,
    // unlocated hops can be interpolated instead of dropped for lack of two
    // located nodes inside the path itself.
    const extraAnchor = extraAnchors && extraAnchors.length ? extraAnchors[0] : undefined;
    const extraIsAnchor = !!extraAnchor
      && Number.isFinite(extraAnchor.lat) && Number.isFinite(extraAnchor.lon);

    const anchors = points
      .map((point, index) => ({ point, index }))
      .filter(item => Number.isFinite(item.point.lat) && Number.isFinite(item.point.lon));

    // With two or more located nodes (the sender anchor included), put every
    // unresolved hop on the geographic segment between its nearest located
    // neighbours. This keeps 5053 → db94 → 565d on the visible edge even when
    // db94 has no GPS data.
    if (anchors.length + (extraIsAnchor ? 1 : 0) >= 2) {
      if (extraIsAnchor && extraAnchor && anchors.length === 1) {
        // Single located hop plus the external anchor: treat the anchor as the
        // leading reference point and extrapolate every hop away from it.
        const only = anchors[0];
        const stepLat = only.point.lat - extraAnchor.lat;
        const stepLon = only.point.lon - extraAnchor.lon;
        for (let j = 0; j < points.length; j += 1) {
          if (j === only.index) continue;
          const distance = Math.abs(j - only.index);
          const sign = j > only.index ? 1 : -1;
          points[j].lat = only.point.lat + stepLat * distance * sign;
          points[j].lon = only.point.lon + stepLon * distance * sign;
        }
      } else {
      for (let i = 0; i < anchors.length - 1; i += 1) {
        const left = anchors[i];
        const right = anchors[i + 1];
        const gap = right.index - left.index;
        if (gap <= 1) continue;

        for (let j = left.index + 1; j < right.index; j += 1) {
          const t = (j - left.index) / gap;
          points[j].lat = left.point.lat + (right.point.lat - left.point.lat) * t;
          points[j].lon = left.point.lon + (right.point.lon - left.point.lon) * t;
        }
      }

      // If unresolved nodes occur before the first or after the last located
      // node, extrapolate using the nearest anchor pair — or, when the path
      // starts with exactly one located hop, using the external anchor as the
      // direction reference (sender → hop).
      const first = anchors[0];
      const second = anchors.length >= 2 ? anchors[1] : undefined;
      const last = anchors[anchors.length - 1];
      const beforeStepLat = second
        ? second.point.lat - first.point.lat
        : extraIsAnchor && extraAnchor ? first.point.lat - extraAnchor.lat : 0;
      const beforeStepLon = second
        ? second.point.lon - first.point.lon
        : extraIsAnchor && extraAnchor ? first.point.lon - extraAnchor.lon : 0;
      for (let j = first.index - 1; j >= 0; j -= 1) {
        const distance = first.index - j;
        points[j].lat = first.point.lat - beforeStepLat * distance;
        points[j].lon = first.point.lon - beforeStepLon * distance;
      }

      const previous = anchors.length >= 2 ? anchors[anchors.length - 2] : undefined;
      const afterStepLat = previous
        ? last.point.lat - previous.point.lat
        : extraIsAnchor && extraAnchor && anchors.length === 1 ? last.point.lat - extraAnchor.lat : 0;
      const afterStepLon = previous
        ? last.point.lon - previous.point.lon
        : extraIsAnchor && extraAnchor && anchors.length === 1 ? last.point.lon - extraAnchor.lon : 0;
      for (let j = last.index + 1; j < points.length; j += 1) {
        const distance = j - last.index;
        points[j].lat = last.point.lat + afterStepLat * distance;
        points[j].lon = last.point.lon + afterStepLon * distance;
      }
      }
    }

    return points.filter(point =>
      Number.isFinite(point.lat) && Number.isFinite(point.lon)
      && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180,
    );
  }

  private _buildPacketMap(data: Record<string, unknown>): MessageMapState {
    const payloadType = Number(data.payload_type);
    const payloadName = String(data.payload_typename || this._payloadTypeName(payloadType));
    const routeName = String(data.route_typename || 'UNKNOWN');
    const pathHashes = this._pathHashes(data);
    const points = this._resolvePathPoints(pathHashes);

    const pathLength = Number(data.path_len);
    const hashSize = Number(data.path_hash_size);
    const route: MessageMapRoute[] = points.length
      ? [{
          points,
          hashPath: pathHashes,
          snr: Number.isFinite(Number(data.snr)) ? Number(data.snr) : undefined,
          rssi: Number.isFinite(Number(data.rssi)) ? Number(data.rssi) : undefined,
        }]
      : [];

    const pathDetails = pathHashes.length
      ? 'path ' + pathHashes.join(' → ')
      : Number.isFinite(pathLength) ? 'path 0 hops' : '';
    const details = [
      routeName,
      pathDetails,
      hashSize ? 'hash ' + hashSize + 'B' : '',
      data.snr !== undefined ? 'SNR ' + data.snr + ' dB' : '',
      data.rssi !== undefined ? 'RSSI ' + data.rssi + ' dBm' : '',
    ].filter(Boolean).join(' · ');

    return {
      sender: 'MeshCore ' + payloadName,
      target: payloadName,
      text: details || 'MeshCore packet received',
      timestamp: data.recv_time || data.timestamp
        ? String(data.recv_time || data.timestamp)
        : undefined,
      routes: route,
    };
  }

  private _payloadTypeName(payloadType: number): string {
    return radioPayloadTypeName(payloadType);
  }

  private _buildAdvertMap(data: Record<string, unknown>): MessageMapState {
    const name = String(data.adv_name || 'Unknown node');
    const advType = Number(data.adv_type);
    const typeName = advType === 2 ? 'Repeater'
      : advType === 3 ? 'Room Server'
      : advType === 4 ? 'Sensor'
      : advType === 1 ? 'Chat node'
      : 'Node';
    const sender = name;
    const target = `Advert · ${typeName}`;
    const advKey = String(data.adv_key || '').toLowerCase();
    const advCoords = nodeCoordinates({
      ...(data as unknown as Contact),
      public_key: advKey,
      pubkey_prefix: advKey.substring(0, 6),
      added_to_node: false,
      adv_name: name,
      type: advType,
      flags: 0,
      adv_lat: Number(data.adv_lat),
      adv_lon: Number(data.adv_lon),
      lastmod: 0,
      last_advert: 0,
      out_path: '',
      out_path_len: 0,
      out_path_hash_mode: 2,
    });
    const senderPoint: MessageMapPoint | undefined = advCoords
      ? { key: advKey || `advert:${name}`, name, lat: advCoords.lat, lon: advCoords.lon }
      : undefined;

    const pathHashes = this._pathHashes(data);
    const points: MessageMapPoint[] = [];
    if (senderPoint) points.push(senderPoint);
    for (const hash of pathHashes) {
      const contact = this._findContactByHash(hash);
      const coords = contact ? nodeCoordinates(contact) : null;
      if (!contact || !coords) continue;
      const point: MessageMapPoint = {
        key: contact.public_key,
        name: this._name(contact),
        lat: coords.lat,
        lon: coords.lon,
      };
      if (!points.some(existing => existing.key === point.key)) points.push(point);
    }

    const route: MessageMapRoute[] = points.length
      ? [{
          points,
          hashPath: pathHashes,
          snr: Number.isFinite(Number(data.snr)) ? Number(data.snr) : undefined,
          rssi: Number.isFinite(Number(data.rssi)) ? Number(data.rssi) : undefined,
        }]
      : [];

    const recvTime = data.recv_time || data.timestamp || data.adv_timestamp;
    const keyPrefix = advKey ? advKey.substring(0, 12) : '';
    const details = [
      keyPrefix ? `key ${keyPrefix}` : '',
      data.path_hash_size ? `hash ${Number(data.path_hash_size)}B` : '',
      data.route_typename ? String(data.route_typename) : '',
      data.snr !== undefined ? `SNR ${data.snr} dB` : '',
      data.rssi !== undefined ? `RSSI ${data.rssi} dBm` : '',
    ].filter(Boolean).join(' · ');

    return {
      sender,
      target,
      text: details || 'Node advertisement received',
      timestamp: recvTime ? String(recvTime) : undefined,
      routes: route,
    };
  }

  private _buildMessageMap(data: Record<string, unknown>): MessageMapState {
    const sender = String(data.sender_name || 'Unknown node');
    const channel = String(data.channel || '');
    const target = channel ? `#${channel}` : sender;
    // MeshCore pubkey prefixes are 8 hex chars; path IDs are the first 2–3
    // bytes (4–6 chars), so match on that shorter prefix.
    const senderPrefix = String(data.pubkey_prefix || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
    const senderContact = (senderPrefix ? this._findContactByHash(senderPrefix) : undefined)
      || this.contacts.find(contact =>
        hasCoordinates(contact)
        && this._name(contact).trim().toLowerCase() === sender.trim().toLowerCase(),
      );
    // Use normalized decimal coordinates — raw MeshCore advert integers must
    // never reach the map projection unconverted.
    const senderCoords = senderContact ? nodeCoordinates(senderContact) : null;
    const senderPoint: MessageMapPoint | undefined = senderContact && senderCoords ? {
      key: senderContact.public_key,
      name: this._name(senderContact),
      lat: senderCoords.lat,
      lon: senderCoords.lon,
    } : undefined;

    const rxLogs = Array.isArray(data.rx_log_data)
      ? data.rx_log_data as Array<Record<string, unknown>>
      : [];
    const sourceLogs = rxLogs.length ? rxLogs : [{}];
    const routes: MessageMapRoute[] = [];

    for (const rx of sourceLogs) {
      const hashPath = this._pathHashes(rx);
      // Pass the sender as an external coordinate anchor: when only one hop
      // of the radio path is located (e.g. 5053 → db94 with no GPS on db94),
      // the remaining hops are extrapolated from sender + anchor instead of
      // being dropped for lack of two anchors inside the path.
      const pathPoints = this._resolvePathPoints(hashPath, senderPoint ? [senderPoint] : undefined);
      // The radio path may start at the transmitting node itself; when the
      // sender is already the first hop of the resolved path, don't duplicate
      // it. Otherwise prepend the sender as an anchor so unlocated tail hops
      // (e.g. a repeater without GPS) still get interpolated instead of being
      // dropped for lack of two coordinate anchors.
      const dedupedPath = senderPoint && pathPoints.length && pathPoints[0].key === senderPoint.key
        ? pathPoints.slice(1)
        : pathPoints;
      const points = senderPoint ? [senderPoint, ...dedupedPath] : pathPoints;
      const uniquePoints: MessageMapPoint[] = [];
      for (const point of points) {
        if (!uniquePoints.some(existing => existing.key === point.key)) uniquePoints.push(point);
      }
      if (uniquePoints.length) {
        routes.push({
          points: uniquePoints,
          hashPath,
          snr: Number.isFinite(Number(rx.snr)) ? Number(rx.snr) : undefined,
          rssi: Number.isFinite(Number(rx.rssi)) ? Number(rx.rssi) : undefined,
        });
      }
    }

    return {
      sender,
      target,
      text: String(data.message || ''),
      channel: channel || undefined,
      pubkeyPrefix: senderPrefix || undefined,
      timestamp: data.timestamp ? String(data.timestamp) : undefined,
      routes,
    };
  }

  private static readonly ROUTE_ARROW_MARKER_ID = 'message-route-arrow';

  private _messageBubblePoint(): { left: number; top: number } {
    const point = this._messageMap?.routes[0]?.points[0];
    if (point) return this._mapPoint(point.lat, point.lon);
    // No route coordinates: anchor the message to the current map viewport,
    // centered horizontally near its upper edge rather than using 0,0.
    return { left: this._mapSize.width / 2, top: 24 };
  }
  private _fitAll() {
    const nodes = this._nodes;
    if (!nodes.length) {
      this._center = DEFAULT_CENTER;
      this._zoom = 5;
      return;
    }

    const minLat = Math.min(...nodes.map(n => n.lat));
    const maxLat = Math.max(...nodes.map(n => n.lat));
    const minLon = Math.min(...nodes.map(n => n.lon));
    const maxLon = Math.max(...nodes.map(n => n.lon));

    this._center = [(minLat + maxLat) / 2, (minLon + maxLon) / 2];

    if (nodes.length === 1) {
      this._zoom = MAX_ZOOM;
      return;
    }

    // Choose the highest zoom level that still keeps every located node
    // inside the viewport. This gives the initial map the maximum useful
    // scale instead of intentionally zooming out one extra level.
    const width = Math.max(this._mapSize.width - 80, 320);
    const height = Math.max(this._mapSize.height - 80, 240);
    let zoom = MIN_ZOOM;

    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
      const [x1, y1] = project(minLat, minLon, z);
      const [x2, y2] = project(maxLat, maxLon, z);
      if (Math.abs(x2 - x1) <= width && Math.abs(y2 - y1) <= height) {
        zoom = z;
      } else {
        break;
      }
    }
    this._zoom = zoom;
  }

  private _focus(contact: Contact) {
    const coords = nodeCoordinates(contact);
    if (!coords) return;
    this._selectedKey = contact.public_key;
    // Use normalized decimal degrees (raw MeshCore advert ints are degrees * 1e6).
    this._center = [coords.lat, coords.lon];
    this._zoom = Math.max(this._zoom, 12);
  }

  private _zoomBy(delta: number) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom + delta));
    if (next === this._zoom) return;

    const previousTiles = this._tileIndices();
    this._tileTransition = {
      tiles: previousTiles,
      scale: 1,
    };
    this._zoom = next;

    this.requestUpdate();
    requestAnimationFrame(() => {
      if (this._tileTransition) {
        this._tileTransition = {
          ...this._tileTransition,
          scale: 2 ** (next - (next - delta)),
        };
        this.requestUpdate();
      }
    });

    if (this._tileTransitionTimer !== undefined) {
      window.clearTimeout(this._tileTransitionTimer);
    }
    this._tileTransitionTimer = window.setTimeout(() => {
      this._tileTransition = undefined;
      this._tileTransitionTimer = undefined;
      this.requestUpdate();
    }, 300);

    this._preloadTiles(this._tileIndices());
  }

  private _labelScale(): number {
    return Math.max(0.55, Math.min(1.35, 2 ** (this._zoom - 12)));
  }

  private _visibleLabelKeys(nodes: MapNode[]): Set<string> {
    const visible = new Set<string>();
    if (this._zoom < 9 || !this._mapSize.width || !this._mapSize.height) {
      return visible;
    }

    const scale = this._labelScale();
    const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    const ordered = [...nodes].sort((a, b) => {
      const aSelected = this._selectedKey === a.contact.public_key ? 1 : 0;
      const bSelected = this._selectedKey === b.contact.public_key ? 1 : 0;
      if (aSelected !== bSelected) return bSelected - aSelected;
      return (Number(b.contact.last_advert) || 0) - (Number(a.contact.last_advert) || 0);
    });

    for (const node of ordered) {
      const point = this._mapPoint(node.lat, node.lon);
      const name = this._name(node.contact);
      const width = Math.min(180, Math.max(42, name.length * 6.6 + 12)) * scale;
      const height = 18 * scale;
      const left = point.left + 10 * scale;
      const top = point.top - height / 2;
      const box = { left, top, right: left + width, bottom: top + height };

      if (box.right < 0 || box.left > this._mapSize.width || box.bottom < 0 || box.top > this._mapSize.height) continue;

      const overlaps = occupied.some(other =>
        box.left < other.right &&
        box.right > other.left &&
        box.top < other.bottom &&
        box.bottom > other.top,
      );

      if (!overlaps) {
        visible.add(node.contact.public_key);
        occupied.push(box);
      }
    }

    return visible;
  }

  private _mapPoint(lat: number, lon: number): { left: number; top: number } {
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const [x, y] = project(lat, lon, this._zoom);
    return {
      left: this._mapSize.width / 2 + x - cx,
      top: this._mapSize.height / 2 + y - cy,
    };
  }

  private _preloadTiles(tiles: Array<{ src: string }>) {
    for (const tile of tiles) {
      if (this._tilePreloadCache.has(tile.src)) continue;
      const image = new Image();
      image.decoding = 'async';
      image.src = tile.src;
      this._tilePreloadCache.set(tile.src, image);
    }
  }

  private _tileIndices(): MapTile[] {
    if (!this._mapSize.width || !this._mapSize.height) return [];
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const firstX = Math.floor((cx - this._mapSize.width / 2) / TILE_SIZE) - 1;
    const lastX = Math.floor((cx + this._mapSize.width / 2) / TILE_SIZE) + 1;
    const firstY = Math.floor((cy - this._mapSize.height / 2) / TILE_SIZE) - 1;
    const lastY = Math.floor((cy + this._mapSize.height / 2) / TILE_SIZE) + 1;
    const count = 2 ** this._zoom;
    const tiles: Array<{ x: number; y: number; left: number; top: number; src: string }> = [];

    for (let x = firstX; x <= lastX; x++) {
      for (let y = firstY; y <= lastY; y++) {
        if (y < 0 || y >= count) continue;
        const wrappedX = ((x % count) + count) % count;
        tiles.push({
          x,
          y,
          left: this._mapSize.width / 2 + x * TILE_SIZE - cx,
          top: this._mapSize.height / 2 + y * TILE_SIZE - cy,
          src: `https://tile.openstreetmap.org/${this._zoom}/${wrappedX}/${y}.png`,
        });
      }
    }
    return tiles;
  }

  private _startDrag(event: PointerEvent) {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    const [x, y] = project(this._center[0], this._center[1], this._zoom);
    this._dragging = true;
    this._dragStart = { x: event.clientX, y: event.clientY };
    this._dragCenterPx = { x, y };
    this._mapEl?.setPointerCapture(event.pointerId);
    this._mapEl?.classList.add('dragging');
    this._addPointerListeners();
  }

  private _drag(event: PointerEvent) {
    if (!this._dragging) return;
    this._panVisual = {
      x: event.clientX - this._dragStart.x,
      y: event.clientY - this._dragStart.y,
    };
    this._schedulePanTransform();
  }

  private _schedulePanTransform() {
    if (this._panAnimationFrame !== undefined) return;
    this._panAnimationFrame = window.requestAnimationFrame(() => {
      this._panAnimationFrame = undefined;
      this._applyPanTransform();
    });
  }

  private _applyPanTransform() {
    const content = this.shadowRoot?.querySelector('.map-content') as HTMLElement | null;
    if (!content) return;
    // Guard against stale/older component instances where the field was not initialized.
    this._panVisual ??= { x: 0, y: 0 };
    content.style.transform = `translate3d(${this._panVisual.x}px, ${this._panVisual.y}px, 0)`;
  }

  private _endDrag() {
    if (!this._dragging) return;
    this._dragging = false;
    this._mapEl?.classList.remove('dragging');

    const { x, y } = this._panVisual;
    if (x !== 0 || y !== 0) {
      const [lat, lon] = unproject(
        this._dragCenterPx.x - x,
        this._dragCenterPx.y - y,
        this._zoom,
      );
      this._center = [lat, lon];
      this._panVisual = { x: 0, y: 0 };
      this._applyPanTransform();
    }

    this._removePointerListeners();
  }

  private _addPointerListeners() {
    this._mapEl?.addEventListener('pointermove', this._onPointerMove);
    this._mapEl?.addEventListener('pointerup', this._onPointerUp);
    this._mapEl?.addEventListener('pointercancel', this._onPointerUp);
  }

  private _removePointerListeners() {
    this._mapEl?.removeEventListener('pointermove', this._onPointerMove);
    this._mapEl?.removeEventListener('pointerup', this._onPointerUp);
    this._mapEl?.removeEventListener('pointercancel', this._onPointerUp);
  }

  private _onPointerMove = (event: Event) => this._drag(event as PointerEvent);
  private _onPointerUp = () => this._endDrag();

  private _onWheel(event: WheelEvent) {
    event.preventDefault();

    const direction = event.deltaY > 0 ? -1 : 1;
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._zoom + direction));
    if (nextZoom === this._zoom || !this._mapSize.width || !this._mapSize.height) {
      return;
    }

    const rect = this._mapEl?.getBoundingClientRect();
    if (!rect) {
      this._zoomBy(direction);
      return;
    }

    // Keep the geographic point currently under the mouse cursor fixed
    // at the same screen position while changing zoom.
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const [centerX, centerY] = project(this._center[0], this._center[1], this._zoom);
    const worldX = centerX + cursorX - this._mapSize.width / 2;
    const worldY = centerY + cursorY - this._mapSize.height / 2;
    const [lat, lon] = unproject(worldX, worldY, this._zoom);

    this._zoomBy(direction);

    const [zoomedX, zoomedY] = project(lat, lon, nextZoom);
    const nextCenterX = zoomedX - cursorX + this._mapSize.width / 2;
    const nextCenterY = zoomedY - cursorY + this._mapSize.height / 2;
    this._center = unproject(nextCenterX, nextCenterY, nextZoom);
  }

  render() {
    const allContacts = [...this.contacts].sort((a, b) => {
      if (this._deviceSort === 'activity') {
        const activityA = Number(a.last_advert) || 0;
        const activityB = Number(b.last_advert) || 0;
        if (activityA !== activityB) return activityB - activityA;
      }
      return this._name(a).localeCompare(this._name(b), undefined, { sensitivity: 'base' });
    });
    const search = this._deviceSearch.trim().toLocaleLowerCase();
    const filteredContacts = search
      ? allContacts.filter(contact =>
          this._name(contact).toLocaleLowerCase().includes(search)
          || contact.pubkey_prefix.toLocaleLowerCase().includes(search),
        )
      : allContacts;

    return html`
      <div class="layout">
        <aside class="sidebar">
          <div class="sidebar-header">
            Devices
            <small>${this._nodes.length} with coordinates / ${allContacts.length} total</small>
          </div>
          <div class="device-search">
            <input
              type="search"
              placeholder="Search devices…"
              aria-label="Search devices"
              .value=${this._deviceSearch}
              @input=${(e: Event) => { this._deviceSearch = (e.target as HTMLInputElement).value; }}>
          </div>
          <div class="sort-select">
            <select
              aria-label="Sort devices"
              .value=${this._deviceSort}
              @change=${(e: Event) => {
                this._deviceSort = (e.target as HTMLSelectElement).value as 'name' | 'activity';
              }}>
              <option value="name">Sort: Name</option>
              <option value="activity">Sort: Last activity</option>
            </select>
          </div>
          <div class="node-list">
            ${filteredContacts.length
              ? filteredContacts.map(contact => {
                  const located = hasCoordinates(contact);
                  const active = this._selectedKey === contact.public_key;
                  const activity = this._activity(contact);
                  return html`
                    <button
                      class="node ${located ? '' : 'no-location'} ${active ? 'active' : ''}"
                      ?disabled=${!located}
                      title=${located ? `Focus on ${this._name(contact)}` : 'No coordinates available'}
                      @click=${() => this._focus(contact)}>
                      <span class="activity ${activity.className}" style=${activity.style || nothing} title=${activity.title} aria-label=${activity.title}>${activity.label}</span>
                      <span>
                        <span class="node-name">${this._name(contact)}</span>
                        <span class="node-prefix">${contact.pubkey_prefix || ''}</span>
                      </span>
                    </button>
                  `;
                })
              : html`
                  <div style="padding:16px;color:var(--secondary-text-color);font-size:13px;">
                    ${allContacts.length ? 'No devices match the search.' : 'No MeshCore nodes found.'}
                  </div>
                `}
          </div>
        </aside>

        <div class="map-area">
        <main
          class="map"
          @pointerdown=${this._startDrag}
          @wheel=${this._onWheel}
          @dblclick=${(e: MouseEvent) => { e.preventDefault(); this._zoomBy(1); }}>
          <div class="map-content">
            ${this._tileTransition ? html`
              <div
                class="tiles transition"
                style="transform:scale(${this._tileTransition.scale});">
                ${this._tileTransition.tiles.map(tile => html`
                  <img class="tile" src=${tile.src} alt="" style="left:${tile.left}px;top:${tile.top}px;">
                `)}
              </div>
            ` : nothing}

            <div class="tiles current">
              ${this._tileIndices().map(tile => html`
                <img class="tile" src=${tile.src} alt="" style="left:${tile.left}px;top:${tile.top}px;">
              `)}
            </div>

            ${this._graphEdges.length ? html`
              <svg class="graph-layer" aria-hidden="true" width="100%" height="100%" viewBox=${`0 0 ${Math.max(1, this._mapSize.width)} ${Math.max(1, this._mapSize.height)}`} preserveAspectRatio="none"><defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,7 L7,3.5 z" class="graph-arrow"></path></marker></defs>
                ${this._graphEdges.map(edge => {
                  const age = Date.now() - edge.lastSeen;
                  const opacity = Math.max(.08, 1 - age / MapPage.GRAPH_TTL_MS);
                  const width = Math.min(6, 1.5 + Math.log2(edge.count + 1));
                  const from = this._mapPoint(edge.from.lat, edge.from.lon);
                  const to = this._mapPoint(edge.to.lat, edge.to.lon);
                  const key = edge.id.replace(/[^a-zA-Z0-9_-]/g, '_');
                  return html`<line class="graph-edge ${age < 15000 ? 'active' : ''}" data-graph-edge=${edge.id} x1=${from.left} y1=${from.top} x2=${to.left} y2=${to.top} marker-end="url(#graph-arrow)" style="opacity:${opacity};stroke-width:${width}px"></line><circle class="graph-packet" data-graph-packet=${key} cx=${from.left} cy=${from.top} r="4"></circle>`;
                })}
                ${[...new Map(this._graphEdges.flatMap(edge => [edge.from, edge.to]).map(point => [point.key, point])).values()].map(point => { const pos = this._mapPoint(point.lat, point.lon); return html`<g class="graph-node-group"><circle class="graph-node" data-graph-node=${point.key} cx=${pos.left} cy=${pos.top} r="7"></circle><text class="graph-node-label" data-graph-node-label=${point.key} x=${pos.left + 10} y=${pos.top - 10}>${point.key.slice(0, 4)}</text></g>`; })}
              </svg>
            ` : nothing}
            <div class="marker-layer">
                    ${(() => {
                      const nodes = this._nodes;
                      return nodes.map(node => {
                        const point = this._mapPoint(node.lat, node.lon);
                        const selected = this._selectedKey === node.contact.public_key;
                        const activity = this._activity(node.contact);
                        return html`
                          <button
                            class="marker activity-marker ${activity.className} ${selected ? "selected" : ""}"
                            title=${activity.title}
                            aria-label=${this._name(node.contact)} — ${activity.title}
                            style="left:${point.left}px;top:${point.top}px;${activity.style || ""}"
                            @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
                            @click=${(e: Event) => { e.stopPropagation(); this._focus(node.contact); }}>
                            <span>${activity.label}</span>
                          </button>
                        `;
                      });
                    })()}
                  </div>
                  <div class="label-layer">
                    ${(() => {
                      const nodes = this._nodes;
                      const visibleLabels = this._visibleLabelKeys(nodes);
                      const labelScale = this._labelScale();
                      return nodes.map(node => {
                        if (!visibleLabels.has(node.contact.public_key)) return nothing;
                        const point = this._mapPoint(node.lat, node.lon);
                        return html`
                          <span class="node-label" style="left:${point.left}px;top:${point.top}px;--label-scale:${labelScale}">
                            ${this._name(node.contact)}
                          </span>
                        `;
                      });
                    })()}
                  </div>
          </div>

        <div
            class="controls"
            @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
            @dblclick=${(e: MouseEvent) => e.stopPropagation()}>
            <button type="button" title="Zoom in" @click=${() => this._zoomBy(1)}>+</button>
            <button type="button" title="Zoom out" @click=${() => this._zoomBy(-1)}>−</button>
            <button type="button" title="Fit all devices" @click=${() => { this._selectedKey = null; this._fitAll(); }}>⌂</button>
          </div>

          ${this._nodes.length
            ? nothing
            : html`<div class="empty-map">No devices with coordinates are available.</div>`}

          <div class="attribution">© OpenStreetMap contributors</div>
        </main>
        <section class="radio-table" aria-label="MeshCore RAW_EVENT radio telemetry">
          ${this._rawRadioRows.length ? html`
            <table>
              <thead><tr><th>Время</th><th>Тип</th><th>Маршрут</th><th>Путь</th><th>Сообщение</th><th>Координаты</th><th>SNR</th><th>RSSI</th><th>Шум</th><th>Радио / пакет</th></tr></thead>
              <tbody>
                ${this._rawRadioRows.map((row, index) => html`
                  <tr class=${`${index === 0 ? 'latest ' : ''}${row.id === this._selectedRadioRowId ? 'selected' : ''}`.trim()} @click=${(e: Event) => { e.stopPropagation(); this._showRadioRow(row); }} title="Показать маршрут этого события">
                    <td>${row.time}</td><td>${row.type}</td><td>${row.route}</td><td class="path">${row.path}</td><td>${row.message === '—' ? nothing : row.message}</td><td>${row.coordinates}</td>
                    <td>${row.snr}</td><td>${row.rssi}</td><td>${row.noise}</td>
                    <td class=${row.telemetry === '—' ? 'muted' : ''}>${row.telemetry}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          ` : html`<div class="radio-table-empty">Ожидание RAW_EVENT…</div>`}
        </section>
        </div>
      </div>
    `;
  }
}