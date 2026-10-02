import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Contact, HomeAssistant, PanelConfig } from '../types';

interface MapNode {
  contact: Contact;
  lat: number;
  lon: number;
}

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

  @state() private _selectedKey: string | null = null;
  @state() private _center: [number, number] = DEFAULT_CENTER;
  @state() private _zoom = 5;
  @state() private _mapSize = { width: 0, height: 0 };
  @state() private _deviceSearch = '';\n  @state() private _activityNow = Date.now();

  private _mapEl?: HTMLElement;
  private _resizeObserver?: ResizeObserver;
  private _dragging = false;
  private _dragStart = { x: 0, y: 0 };
  private _dragCenterPx = { x: 0, y: 0 };\n  private _wheelZoomTimer?: number;\n  private _pendingZoomDelta = 0;\n  private _activityTimer?: number;

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
    }

    .tiles.current {
      z-index: 1;
      pointer-events: none;
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
      pointer-events: none;
    }

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

    .marker.selected {
      width: 22px;
      height: 22px;
      background: var(--accent-color, #ff9800);
      z-index: 2;
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
    this._resizeObserver = new ResizeObserver(() => {
      const rect = this.getBoundingClientRect();
      this._mapSize = { width: rect.width, height: rect.height };
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
    this._tileTransition = { tiles: previousTiles, scale: 2 ** (next - this._zoom) };
    this._zoom = next;

    if (this._tileTransitionTimer !== undefined) {
      window.clearTimeout(this._tileTransitionTimer);
    }
    this._tileTransitionTimer = window.setTimeout(() => {
      this._tileTransition = undefined;
      this._tileTransitionTimer = undefined;
      this.requestUpdate();
    }, 260);
  }

  private _mapPoint(lat: number, lon: number): { left: number; top: number } {
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const [x, y] = project(lat, lon, this._zoom);
    return {
      left: this._mapSize.width / 2 + x - cx,
      top: this._mapSize.height / 2 + y - cy,
    };
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
    this._zoomBy(direction);
  }

  render() {
    const allContacts = [...this.contacts].sort((a, b) =>
      this._name(a).localeCompare(this._name(b), undefined, { sensitivity: 'base' }),
    );
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
              ${this._nodes.map(node => {
                const point = this._mapPoint(node.lat, node.lon);
                const selected = this._selectedKey === node.contact.public_key;
                return html`
                  <button
                    class="marker ${selected ? 'selected' : ''}"
                    title=${this._name(node.contact)}
                    aria-label=${this._name(node.contact)}
                    style="left:${point.left}px;top:${point.top}px;"
                    @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
                    @click=${(e: Event) => { e.stopPropagation(); this._focus(node.contact); }}>
                  </button>
                `;
              })}
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
