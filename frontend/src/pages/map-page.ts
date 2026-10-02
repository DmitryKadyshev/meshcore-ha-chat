import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Contact, HomeAssistant, PanelConfig } from '../types';

interface MapNode {
  contact: Contact;
  lat: number;
  lon: number;
}

interface MessageMapPoint { key: string; name: string; lat: number; lon: number; }
interface MessageMapRoute { points: MessageMapPoint[]; hashPath: string[]; snr?: number; rssi?: number; }
interface MessageMapState { sender: string; target: string; text: string; timestamp?: string; routes: MessageMapRoute[]; }

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const DEFAULT_CENTER: [number, number] = [50, 10];

function hasCoordinates(contact: Contact): boolean {
  return Number.isFinite(contact.adv_lat)
    && Number.isFinite(contact.adv_lon)
    && Math.abs(contact.adv_lat) <= 90
    && Math.abs(contact.adv_lon) <= 180
    && !(contact.adv_lat === 0 && contact.adv_lon === 0);
}

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
  @state() private _deviceSearch = '';\n  @state() private _deviceSort: 'name' | 'activity' = 'name';\n  @state() private _activityNow = Date.now();
  @state() private _showMessage = false;
  @state() private _messageMap: MessageMapState | null = null;

  private _mapEl?: HTMLElement;
  private _resizeObserver?: ResizeObserver;
  private _dragging = false;
  private _dragStart = { x: 0, y: 0 };
  private _dragCenterPx = { x: 0, y: 0 };\n  private _wheelZoomTimer?: number;\n  private _pendingZoomDelta = 0;\n  private _activityTimer?: number;
  private _messageUnsubscribers: Array<() => void> = [];
  private _messageSubscriptionsActive = false;
  private _tilePreloadCache = new Map<string, HTMLImageElement>();

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

    .sort-select {\n      padding: 8px 10px;\n      border-bottom: 1px solid var(--divider-color, #e0e0e0);\n      flex-shrink: 0;\n    }\n\n    .sort-select select {\n      width: 100%;\n      box-sizing: border-box;\n      padding: 7px 9px;\n      border: 1px solid var(--divider-color, #ccc);\n      border-radius: 7px;\n      background: var(--primary-background-color, #fafafa);\n      color: var(--primary-text-color);\n      font: inherit;\n      font-size: 12px;\n    }\n\n    .message-toggle {
      padding: 9px 10px;
      border-bottom: 1px solid var(--divider-color, #e0e0e0);
      flex-shrink: 0;
    }
    .message-toggle label {
      display: flex;
      align-items: center;
      gap: 9px;
      color: var(--primary-text-color);
      font-size: 13px;
      cursor: pointer;
      user-select: none;
    }
    .message-toggle input { width: 17px; height: 17px; margin: 0; accent-color: var(--primary-color, #03a9f4); }
    .message-toggle small { display: block; margin: 3px 0 0 26px; color: var(--secondary-text-color); font-size: 10px; }

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
    .message-route-layer { position: absolute; inset: 0; z-index: 3; pointer-events: none; overflow: visible; }
    .message-route { fill: none; stroke: rgba(3,169,244,.9); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 1px 2px rgba(0,0,0,.35)); }
    .message-route.secondary { stroke: rgba(255,152,0,.72); stroke-width: 2.5; }
    .message-hop { fill: var(--card-background-color,#fff); stroke: var(--primary-color,#03a9f4); stroke-width: 2; }
    .message-hop-label { font-size: 10px; font-weight: 600; fill: var(--primary-text-color,#222); paint-order: stroke; stroke: rgba(255,255,255,.85); stroke-width: 3px; stroke-linejoin: round; }
    .message-bubble { position: absolute; z-index: 5; max-width: min(360px,calc(100% - 32px)); min-width: 180px; padding: 10px 12px; border: 1px solid rgba(3,169,244,.45); border-radius: 12px; background: rgba(255,255,255,.94); color: #222; box-shadow: 0 4px 16px rgba(0,0,0,.28); transform: translate(14px,calc(-100% - 14px)); pointer-events: none; overflow: hidden; }
    .message-bubble::after { content: ''; position: absolute; left: 10px; bottom: -7px; width: 14px; height: 14px; background: rgba(255,255,255,.94); border-right: 1px solid rgba(3,169,244,.45); border-bottom: 1px solid rgba(3,169,244,.45); transform: rotate(45deg); }
    .message-bubble-title { position: relative; z-index: 1; font-size: 12px; font-weight: 700; color: var(--primary-color,#03a9f4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .message-bubble-sender { position: relative; z-index: 1; margin-top: 2px; font-size: 10px; color: var(--secondary-text-color,#666); }
    .message-bubble-text { position: relative; z-index: 1; margin-top: 5px; font-size: 13px; line-height: 1.3; white-space: pre-wrap; overflow-wrap: anywhere; }
    .message-bubble-route { position: relative; z-index: 1; margin-top: 6px; font-size: 10px; color: var(--secondary-text-color,#666); }

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
    this._resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      this._mapSize = { width, height };
      this._fitAll();
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

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('hass') || changed.has('devicePrefix')) this._setupMessageSubscriptions();
    this._applyPanTransform();
    if (changed.has('contacts')) {
      const hadSelected = this._selectedKey && this.contacts.some(
        c => c.public_key === this._selectedKey && hasCoordinates(c),
      );
      if (!hadSelected) this._selectedKey = null;
      this._fitAll();
    }
  }

  private get _nodes(): MapNode[] {
    return this.contacts
      .filter(hasCoordinates)
      .map(contact => ({ contact, lat: contact.adv_lat, lon: contact.adv_lon }));
  }

  private _name(contact: Contact): string {
    return contact.adv_name || contact.pubkey_prefix || 'Unknown node';
  }

  private _activity(contact: Contact): { className: string; label: string; title: string; style?: string } {
    const timestamp = Number(contact.last_advert);
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
      ? 'Active less than 1 minute ago'
      : `Last advert: ${label} ago`;

    return { className, label, title, style };
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
      this._zoom = 12;
      return;
    }

    const width = Math.max(this._mapSize.width - 80, 320);
    const height = Math.max(this._mapSize.height - 80, 240);
    let zoom = MAX_ZOOM;

    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
      const [x1, y1] = project(minLat, minLon, z);
      const [x2, y2] = project(maxLat, maxLon, z);
      if (Math.abs(x2 - x1) <= width && Math.abs(y2 - y1) <= height) {
        zoom = z;
        break;
      }
    }
    this._zoom = Math.max(MIN_ZOOM, zoom - 1);
  }

  private _focus(contact: Contact) {
    if (!hasCoordinates(contact)) return;
    this._selectedKey = contact.public_key;
    this._center = [contact.adv_lat, contact.adv_lon];
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

  private _tileIndices(): Array<{ x: number; y: number; left: number; top: number; src: string }> {
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

            <div class="marker-layer">
              ${(() => {
                const nodes = this._nodes;
                return nodes.map(node => {
                  const point = this._mapPoint(node.lat, node.lon);
                  const selected = this._selectedKey === node.contact.public_key;
                  const activity = this._activity(node.contact);
                  return html`
                    <button
                      class="marker activity-marker ${activity.className} ${selected ? 'selected' : ''}"
                      title=${activity.title}
                      aria-label=${this._name(node.contact)} — ${activity.title}
                      style="left:${point.left}px;top:${point.top}px;${activity.style || ''}"
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
                    <span
                      class="node-label"
                      style="left:${point.left}px;top:${point.top}px;--label-scale:${labelScale}">
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
      </div>
    `;
  }
}
