// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, HomeAssistant, PanelConfig } from '../src/types';

// map-page only touches ../api through the shared panel graph; stub it so
// importing the page never reaches a real network path.
vi.mock('../src/api', () => ({
  getMessagesAround: vi.fn(async () => ({ messages: [] })),
}));

import '../src/pages/map-page';
import type { MapPage } from '../src/pages/map-page';

// ─── Types for the private surface used by the tests ──────────────────────

interface MessageMapPoint { key: string; name: string; lat: number; lon: number; }
interface MessageMapRoute { points: MessageMapPoint[]; hashPath: string[]; snr?: number; rssi?: number; }
interface MessageMapState {
  sender: string; target: string; text: string; channel?: string;
  pubkeyPrefix?: string; timestamp?: string; routes: MessageMapRoute[];
}
interface GraphEdge {
  id: string; from: MessageMapPoint; to: MessageMapPoint; count: number;
  lastSeen: number; flowStartedAt: number; snr?: number; rssi?: number;
}

interface RawRadioRow { id: number; type: string; route: string; }

interface PrivateMapPage {
  _showMessage: boolean;
  _messageMap: MessageMapState | null;
  _graphEdges: GraphEdge[];
  _center: [number, number];
  _zoom: number;
  _mapSize: { width: number; height: number };
  _latestRadioRx: Record<string, unknown> | null;
  _rawRadioRows: RawRadioRow[];
  _pathHashes(rx: Record<string, unknown>): string[];
  _resolvePathPoints(hashes: string[]): MessageMapPoint[];
  _recordFloodGraph(data: Record<string, unknown>, rx?: Record<string, unknown>): void;
  _buildMessageMap(data: Record<string, unknown>): MessageMapState;
  _buildPacketMap(data: Record<string, unknown>): MessageMapState;
  _fitMessage(): void;
  _fitGraph(): void;
}

function priv(page: MapPage): PrivateMapPage {
  return page as unknown as PrivateMapPage;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MIN_ZOOM = 2;
const MAX_ZOOM = 18;

/** A node public key whose first bytes are `prefix` (MeshCore path IDs). */
function keyFor(prefix: string): string {
  return prefix + 'aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55';
}

function makeContact(prefix: string, name: string, lat: number, lon: number): Contact {
  return {
    public_key: keyFor(prefix),
    pubkey_prefix: prefix,
    added_to_node: true,
    adv_name: name,
    type: 1,
    flags: 0,
    // NaN models "no GPS advertised" — the realistic upstream shape.
    adv_lat: lat,
    adv_lon: lon,
    lastmod: 1700000000,
    last_advert: 1700000000,
    out_path: '',
    out_path_len: 0,
    out_path_hash_mode: 2,
  } as Contact;
}

// 5053 → db94 → 565d → 694d, mirroring the reported live packet.
// db94 and 694d have NO coordinates.
const NODE_5053 = makeContact('5053', 'Node 5053', 50.0, 10.0);
const NODE_DB94 = makeContact('db94', 'Node DB94', Number.NaN, Number.NaN);
const NODE_565D = makeContact('565d', 'Node 565D', 52.0, 12.0);
const NODE_694D = makeContact('694d', 'Node 694D', Number.NaN, Number.NaN);
const CONTACTS: Contact[] = [NODE_5053, NODE_DB94, NODE_565D, NODE_694D];

function makeConfig(overrides: Partial<PanelConfig> = {}): PanelConfig {
  return {
    node_name: 'TestNode',
    node_prefix: '5053',
    channel_entity_pattern: 'binary_sensor.meshcore_aa_ch_{idx}_messages',
    contact_entity_pattern: 'binary_sensor.meshcore_aa_{contact}_messages',
    recipient_type_entity: 'select.meshcore_recipient_type',
    channel_entity: 'select.meshcore_channel',
    contact_entity: 'select.meshcore_contact',
    domain_filter: 'meshcore',
    hours_to_show: 48,
    initial_hours: 1,
    max_messages: 500,
    show_date_separators: true,
    group_messages: true,
    group_timeout: 300,
    timestamp_format: 'relative',
    update_mode: 'auto',
    refresh_interval: 30,
    enable_cache: true,
    cache_ttl: 86400,
    cache_max_size: 5242880,
    entry_id: 'test-entry',
    ...overrides,
  };
}

type EventCallback = (event: { data?: Record<string, unknown> }) => void;

let capturedHandlers: Map<string, EventCallback>;

function makeMockHass(): HomeAssistant {
  return {
    states: {},
    entities: {},
    callApi: async () => ({}) as never,
    callService: async () => {},
    callWS: async () => ({}) as never,
    connection: {
      subscribeEvents: (cb: EventCallback, eventType: string): Promise<() => void> => {
        capturedHandlers.set(eventType, cb);
        return Promise.resolve(() => {});
      },
      subscribeMessage: async <T>(_cb: (event: T) => void, _msg: Record<string, unknown>) => () => {},
    },
    themes: { darkMode: false },
    language: 'en',
    locale: {},
    dockedSidebar: 'auto',
  } as unknown as HomeAssistant;
}

function fireRawEvent(data: Record<string, unknown>): void {
  capturedHandlers.get('meshcore_raw_event')?.({ data });
}

function fireMessageEvent(data: Record<string, unknown>): void {
  capturedHandlers.get('meshcore_message')?.({ data });
}

async function mountMapPage(): Promise<MapPage> {
  const el = document.createElement('meshcore-map-page') as unknown as MapPage;
  el.hass = makeMockHass();
  el.config = makeConfig();
  el.contacts = [...CONTACTS];
  document.body.appendChild(el);
  await el.updateComplete;
  // Let the async subscribeEvents promises settle so handlers are captured.
  await new Promise((r) => setTimeout(r, 0));
  // The map viewport is zero-sized in happy-dom; give it a realistic size
  // so fit logic has meaningful bounds.
  priv(el)._mapSize = { width: 800, height: 600 };
  return el;
}

/** RX_LOG_DATA payload for a flood packet with the ordered 2-byte path. */
function rxLogPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payload_type: 3,
    payload_typename: 'ACK',
    route_typename: 'FLOOD',
    path_len: 3,
    path_hash_size: 2,
    path: '5053db94565d',
    path_nodes: ['5053', 'db94', '565d'],
    snr: -12.5,
    rssi: -98,
    recv_time: 1759000000,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('MeshCore map route resolution (_resolvePathPoints)', () => {
  let el: MapPage;

  beforeEach(async () => {
    capturedHandlers = new Map();
    el = await mountMapPage();
  });

  afterEach(() => {
    el.remove();
  });

  it('keeps an intermediate hop without GPS between two located anchors', () => {
    // 5053 (GPS) → db94 (no GPS) → 565d (GPS) must stay a 3-point route.
    const points = priv(el)._resolvePathPoints(['5053', 'db94', '565d']);
    expect(points.map(p => p.name)).toEqual(['Node 5053', 'Node DB94', 'Node 565D']);
    for (const point of points) {
      expect(Number.isFinite(point.lat)).toBe(true);
      expect(Number.isFinite(point.lon)).toBe(true);
    }
    // The interpolated hop lies on the segment between the anchors.
    const mid = points[1];
    expect(mid.lat).toBeCloseTo(51.0, 5);
    expect(mid.lon).toBeCloseTo(11.0, 5);
  });

  it('interpolates multiple unlocated hops between two anchors (A→B→C→D)', () => {
    const points = priv(el)._resolvePathPoints(['5053', 'db94', '694d', '565d']);
    expect(points).toHaveLength(4);
    expect(points[0].lat).toBeCloseTo(50.0, 5);
    expect(points[1].lat).toBeCloseTo(50 + 2 / 3, 5);
    expect(points[2].lat).toBeCloseTo(50 + 4 / 3, 5);
    expect(points[3].lat).toBeCloseTo(52.0, 5);
    // Order is preserved — never sorted or deduplicated geographically.
    expect(points.map(p => p.name)).toEqual(['Node 5053', 'Node DB94', 'Node 694D', 'Node 565D']);
  });

  it('extrapolates trailing unlocated hops past the last anchor instead of dropping them', () => {
    // 5053 → db94 → 565d → 694d where 694d (the tail) has no GPS.
    const points = priv(el)._resolvePathPoints(['5053', 'db94', '565d', '694d']);
    expect(points).toHaveLength(4);
    expect(points[3].name).toBe('Node 694D');
    expect(Number.isFinite(points[3].lat)).toBe(true);
    expect(Number.isFinite(points[3].lon)).toBe(true);
    // Continues along the direction of the previous located step.
    expect(points[3].lat).toBeCloseTo(54.0, 5);
    expect(points[3].lon).toBeCloseTo(14.0, 5);
  });

  it('extrapolates leading unlocated hops before the first anchor', () => {
    const points = priv(el)._resolvePathPoints(['694d', '5053', '565d']);
    expect(points).toHaveLength(3);
    expect(points[0].name).toBe('Node 694D');
    expect(Number.isFinite(points[0].lat)).toBe(true);
    expect(points[0].lat).toBeCloseTo(48.0, 5);
    expect(points[0].lon).toBeCloseTo(8.0, 5);
  });

  it('never emits invalid coordinates into the resolved route', () => {
    const points = priv(el)._resolvePathPoints(['5053', 'db94', '565d', '694d']);
    for (const point of points) {
      expect(Number.isNaN(point.lat)).toBe(false);
      expect(Number.isNaN(point.lon)).toBe(false);
      expect(Math.abs(point.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(point.lon)).toBeLessThanOrEqual(180);
    }
  });

  it('drops the whole route when no hop has coordinates (nothing to anchor on)', () => {
    // Only db94/694d appear in the path and neither is located.
    const points = priv(el)._resolvePathPoints(['db94', '694d']);
    expect(points).toHaveLength(0);
  });

  it('parses ordered hashes from raw hex path with fallback widths', () => {
    expect(priv(el)._pathHashes({ path: '5053db94565d', path_len: 3, path_hash_size: 2 }))
      .toEqual(['5053', 'db94', '565d']);
    expect(priv(el)._pathHashes({ path: '5053db94565d' })).toEqual(['5053', 'db94', '565d']);
  });
});

describe('MeshCore map technical radio route graph (RX_LOG_DATA)', () => {
  let el: MapPage;

  beforeEach(async () => {
    capturedHandlers = new Map();
    el = await mountMapPage();
    priv(el)._showMessage = true;
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  it('builds ordered directed edges for a non-text packet with a partial-GPS path', () => {
    fireRawEvent({
      event_type: 'RX_LOG_DATA',
      timestamp: 1759000000,
      payload: rxLogPayload(),
    });

    const edges = priv(el)._graphEdges;
    // Three resolved points → two ordered transitions, none lost to missing GPS.
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.id)).toEqual([
      `${keyFor('5053')}|${keyFor('db94')}`,
      `${keyFor('db94')}|${keyFor('565d')}`,
    ]);
    // Direction preserved: 5053 → db94 → 565d.
    expect(edges[0].from.name).toBe('Node 5053');
    expect(edges[0].to.name).toBe('Node DB94');
    expect(edges[1].from.name).toBe('Node DB94');
    expect(edges[1].to.name).toBe('Node 565D');
    // Every edge endpoint carries finite coordinates so fit bounds work.
    for (const edge of edges) {
      for (const point of [edge.from, edge.to]) {
        expect(Number.isFinite(point.lat)).toBe(true);
        expect(Number.isFinite(point.lon)).toBe(true);
      }
    }
  });

  it('renders the route graph in the shadow DOM after the radio event', async () => {
    fireRawEvent({
      event_type: 'RX_LOG_DATA',
      timestamp: 1759000000,
      payload: rxLogPayload(),
    });
    await el.updateComplete;

    const layer = el.shadowRoot!.querySelector('.graph-layer');
    expect(layer).toBeTruthy();
    const lines = el.shadowRoot!.querySelectorAll('.graph-edge');
    expect(lines.length).toBe(2);
    // Intermediate node without GPS still gets a visible vertex.
    const vertices = el.shadowRoot!.querySelectorAll('.graph-node');
    expect(vertices.length).toBe(3);
  });

  it('does not zoom out to the minimum level when fitting the graph (BUG-1)', () => {
    fireRawEvent({
      event_type: 'RX_LOG_DATA',
      timestamp: 1759000000,
      payload: rxLogPayload(),
    });

    const p = priv(el);
    expect(p._graphEdges.length).toBeGreaterThan(0);
    // BUG-1 regression: previously empty bounds collapsed the map to MIN_ZOOM.
    expect(p._zoom).toBeGreaterThan(MIN_ZOOM);
    expect(p._zoom).toBeLessThan(MAX_ZOOM);
    // Centered on the route midpoint, not the world/default center.
    expect(p._center[0]).toBeCloseTo(51.0, 5);
    expect(p._center[1]).toBeCloseTo(11.0, 5);
  });

  it('accepts EventType-namespaced event and payload type names (BUG-4)', () => {
    fireRawEvent({
      event_type: 'EventType.RX_LOG_DATA',
      timestamp: 1759000000,
      payload: rxLogPayload({ payload_typename: 'EventType.ACK' }),
    });

    expect(priv(el)._graphEdges).toHaveLength(2);
  });

  it('handles any technical payload type with a path, not only FLOOD ACKs', () => {
    // PATH_INFO-style packet (payload_type 8) with a 4-hop path including
    // an unlocated tail node.
    fireRawEvent({
      event_type: 'RX_LOG_DATA',
      timestamp: 1759000000,
      payload: rxLogPayload({
        payload_type: 8,
        payload_typename: 'PATH',
        path_len: 4,
        path: '5053db94565d694d',
        path_nodes: ['5053', 'db94', '565d', '694d'],
      }),
    });

    const edges = priv(el)._graphEdges;
    expect(edges).toHaveLength(3);
    expect(edges.map(e => e.id.split('|').map(k => k.slice(0, 4)))).toEqual([
      ['5053', 'db94'],
      ['db94', '565d'],
      ['565d', '694d'],
    ]);
  });

  it('leaves text packets (TEXT_MSG / GRP_TXT) to the message map, not the graph', () => {
    fireRawEvent({
      event_type: 'RX_LOG_DATA',
      timestamp: 1759000000,
      payload: rxLogPayload({ payload_type: 2, payload_typename: 'TEXT_MSG' }),
    });
    expect(priv(el)._graphEdges).toHaveLength(0);

    fireRawEvent({
      event_type: 'RX_LOG_DATA',
      timestamp: 1759000001,
      payload: rxLogPayload({ payload_type: 5, payload_typename: 'GRP_TXT' }),
    });
    expect(priv(el)._graphEdges).toHaveLength(0);
  });

  it('filters noisy events (NO_MORE_MSGS, BATTERY) from the raw table', () => {
    fireRawEvent({
      event_type: 'NO_MORE_MSGS',
      timestamp: 1759000000,
      payload: rxLogPayload({ payload_typename: 'NO_MORE_MSGS' }),
    });
    fireRawEvent({
      event_type: 'EventType.BATTERY',
      timestamp: 1759000001,
      payload: rxLogPayload({ payload_typename: 'BATTERY' }),
    });
    expect(priv(el)._rawRadioRows).toHaveLength(0);
  });

  it('re-fits the graph when contacts arrive after the radio event', () => {
    // Start with db94 unknown to the contact list — it resolves by hash.
    el.contacts = [NODE_5053, NODE_565D];
    fireRawEvent({
      event_type: 'RX_LOG_DATA',
      timestamp: 1759000000,
      payload: rxLogPayload(),
    });
    expect(priv(el)._graphEdges).toHaveLength(2);

    // Now db94 becomes known but still without GPS: route must survive.
    el.contacts = [...CONTACTS];
    return el.updateComplete.then(() => {
      expect(priv(el)._graphEdges).toHaveLength(2);
      expect(priv(el)._zoom).toBeGreaterThan(MIN_ZOOM);
    });
  });
});

describe('MeshCore map text message route (meshcore_message)', () => {
  let el: MapPage;

  beforeEach(async () => {
    capturedHandlers = new Map();
    el = await mountMapPage();
    priv(el)._showMessage = true;
    await el.updateComplete;
  });

  afterEach(() => {
    el.remove();
  });

  it('builds an ordered route from rx_log_data even when a repeater lacks GPS', () => {
    fireMessageEvent({
      entity_id: 'sensor.meshcore_5053aa_messages',
      sender_name: 'Node 565D',
      pubkey_prefix: '565daa55',
      message: 'hello mesh',
      channel: 'general',
      timestamp: 1759000000,
      rx_log_data: [{
        path_len: 2,
        path_hash_size: 2,
        path: '5053db94',
        path_nodes: ['5053', 'db94'],
        snr: -11,
        rssi: -95,
      }],
    });

    const map = priv(el)._messageMap;
    expect(map).toBeTruthy();
    expect(map!.routes).toHaveLength(1);
    const names = map!.routes[0].points.map(p => p.name);
    // Sender (565d, located) → 5053 → db94 (unlocated, interpolated).
    expect(names).toEqual(['Node 565D', 'Node 5053', 'Node DB94']);
    for (const point of map!.routes[0].points) {
      expect(Number.isFinite(point.lat)).toBe(true);
      expect(Number.isFinite(point.lon)).toBe(true);
    }
  });

  it('renders the message route polyline and keeps the text accessible', async () => {
    fireMessageEvent({
      entity_id: 'sensor.meshcore_5053aa_messages',
      sender_name: 'Node 565D',
      pubkey_prefix: '565daa55',
      message: 'hello mesh',
      timestamp: 1759000000,
      rx_log_data: [{
        path_len: 2,
        path_hash_size: 2,
        path: '5053db94',
        path_nodes: ['5053', 'db94'],
      }],
    });
    await el.updateComplete;

    const polyline = el.shadowRoot!.querySelector('.message-route');
    expect(polyline).toBeTruthy();
    const pointsAttr = polyline!.getAttribute('points') || '';
    expect(pointsAttr.split(' ').length).toBeGreaterThanOrEqual(3);
    // No degenerate NaN screen coordinates in the rendered polyline.
    expect(pointsAttr).not.toMatch(/NaN/);

    const bubble = el.shadowRoot!.querySelector('.message-bubble-text');
    expect(bubble?.textContent).toContain('hello mesh');
  });

  it('fits the message route above the minimum zoom (no full-world zoom-out)', () => {
    fireMessageEvent({
      entity_id: 'sensor.meshcore_5053aa_messages',
      sender_name: 'Node 565D',
      pubkey_prefix: '565daa55',
      message: 'hello mesh',
      timestamp: 1759000000,
      rx_log_data: [{
        path_len: 2,
        path_hash_size: 2,
        path: '5053db94',
        path_nodes: ['5053', 'db94'],
      }],
    });

    expect(priv(el)._zoom).toBeGreaterThan(MIN_ZOOM);
    expect(priv(el)._zoom).toBeLessThan(MAX_ZOOM);
  });

  it('keeps a single-point route visible at a sane zoom', () => {
    fireMessageEvent({
      entity_id: 'sensor.meshcore_5053aa_messages',
      sender_name: 'Node 565D',
      pubkey_prefix: '565daa55',
      message: 'direct ping',
      timestamp: 1759000000,
      rx_log_data: [],
    });

    const map = priv(el)._messageMap;
    expect(map!.routes).toHaveLength(1);
    expect(map!.routes[0].points).toHaveLength(1);
    expect(priv(el)._zoom).toBe(12);
  });

  it('shows the "route unavailable" bubble instead of zooming out when nothing resolves', () => {
    fireMessageEvent({
      entity_id: 'sensor.meshcore_5053aa_messages',
      sender_name: 'Unknown Node',
      message: 'orphan message',
      timestamp: 1759000000,
      rx_log_data: [{ path_len: 1, path_hash_size: 2, path: 'ffff' }],
    });

    const map = priv(el)._messageMap;
    expect(map!.routes.every(r => r.points.length === 0)).toBe(true);
    // Map position untouched — no zoom-out (BUG-1 class regression).
    expect(priv(el)._zoom).toBe(5);
  });

  it('technical packet map exposes path details for the RAW_EVENT info line', () => {
    const packetMap = priv(el)._buildPacketMap(rxLogPayload());
    expect(packetMap.text).toContain('path 5053 → db94 → 565d');
    expect(packetMap.text).toContain('SNR -12.5 dB');
    expect(packetMap.text).toContain('RSSI -98 dBm');
    expect(packetMap.routes[0].hashPath).toEqual(['5053', 'db94', '565d']);
  });
});
