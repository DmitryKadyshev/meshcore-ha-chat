import type { Contact } from './types';

export const MESHCORE_PAYLOAD_TYPES: Record<number, string> = {
  0: 'REQ',
  1: 'RESPONSE',
  2: 'TEXT_MSG',
  3: 'ACK',
  4: 'ADVERT',
  5: 'GRP_TXT',
  6: 'GRP_DATA',
  7: 'ANON_REQ',
  8: 'PATH',
  9: 'TRACE',
  10: 'MULTIPART',
  11: 'CONTROL',
  15: 'RAW_CUSTOM',
};

export function payloadTypeName(payloadType: number): string {
  return MESHCORE_PAYLOAD_TYPES[payloadType] || 'UNKNOWN (' + payloadType + ')';
}

export function pathHashes(rx: Record<string, unknown>): string[] {
  const nested = [
    rx,
    ...(rx.parsed && typeof rx.parsed === 'object' ? [rx.parsed as Record<string, unknown>] : []),
    ...(rx.decrypted && typeof rx.decrypted === 'object' ? [rx.decrypted as Record<string, unknown>] : []),
  ];

  const explicitHashSize = nested
    .map(item => Number(item.path_hash_size))
    .find(value => Number.isFinite(value) && Number.isInteger(value) && value >= 1 && value <= 3);
  const width = explicitHashSize ? explicitHashSize * 2 : 0;

  for (const source of nested) {
    const pathNodes = Array.isArray(source.path_nodes) ? source.path_nodes : null;
    if (!pathNodes?.length) continue;
    const hashes = pathNodes
      .map(node => typeof node === 'object' && node !== null
        ? String((node as Record<string, unknown>).hash || '')
        : String(node))
      .map(value => value.replace(/[^0-9a-f]/gi, '').toLowerCase())
      .filter(Boolean);
    if (hashes.length && (!width || hashes.every(hash => hash.length === width))) return hashes;
  }

  const source = nested.find(item => typeof item.path === 'string' && item.path);
  const path = String(source?.path || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (!path) return [];

  let hashWidth = width;
  if (!hashWidth) {
    const pathLen = nested
      .map(item => Number(item.path_len))
      .find(value => Number.isFinite(value) && value > 0);
    // MeshCore path hashes are 1–3 bytes (2/4/6 hex chars). Derive the width
    // from path_len first, then fall back to the string geometry. The old
    // `path.length / pathLen` formula inverted hop count and hash size and
    // silently dropped every hop when they disagreed.
    if (pathLen && pathLen >= 1 && pathLen <= 100 && path.length % pathLen === 0) {
      const derived = path.length / pathLen;
      if ([2, 4, 6].includes(derived)) hashWidth = derived;
    }
    if (!hashWidth) {
      // path_len can be unreliable, so only accept a fallback width when the
      // resulting hop count agrees with path_len (or path_len is absent).
      const agrees = (hops: number) => hops >= 1 && hops <= 100 && (!pathLen || pathLen === hops);
      if (path.length % 2 === 0 && agrees(path.length / 2)) hashWidth = 2;
      if (!hashWidth && path.length % 4 === 0 && agrees(path.length / 4)) hashWidth = 4;
      if (!hashWidth && path.length % 6 === 0 && agrees(path.length / 6)) hashWidth = 6;
      if (!hashWidth && pathLen) {
        if (path.length === pathLen * 2) hashWidth = 2;
        else if (path.length === pathLen * 4) hashWidth = 4;
        else if (path.length === pathLen * 6) hashWidth = 6;
      }
    }
  }
  if (!hashWidth || !Number.isInteger(hashWidth) || hashWidth < 2 || hashWidth > 6) {
    // Without any reliable hint, MeshCore path IDs are 2–3 bytes (4/6 hex
    // chars). Prefer the widest standard width that divides the path evenly;
    // only fall back to 1-byte hashes when the length cannot be anything else.
    hashWidth = path.length % 6 === 0 ? 6 : path.length % 4 === 0 ? 4 : 2;
  }

  const hashes: string[] = [];
  for (let i = 0; i + hashWidth <= path.length; i += hashWidth) {
    hashes.push(path.slice(i, i + hashWidth));
  }
  return hashes;
}

export function hasCoordinates(contact: Contact): boolean {
  // MeshCore advert lat/lon arrive as raw protocol integers (degrees *
  // 1e6). Values outside the raw-int range are already decimal degrees.
  const isRawInt = (value: number) => Number.isInteger(value) && Math.abs(value) > 180;
  const rawLat = Number(contact.adv_lat);
  const rawLon = Number(contact.adv_lon);
  const lat = isRawInt(rawLat) ? rawLat / 1e6 : rawLat;
  const lon = isRawInt(rawLon) ? rawLon / 1e6 : rawLon;
  return Number.isFinite(lat)
    && Number.isFinite(lon)
    && Math.abs(lat) <= 90
    && Math.abs(lon) <= 180
    && !(lat === 0 && lon === 0);
}

/** Mappable decimal coordinates of a contact, or null when unlocated. */
export function nodeCoordinates(contact: Contact): { lat: number; lon: number } | null {
  if (!hasCoordinates(contact)) return null;
  const isRawInt = (value: number) => Number.isInteger(value) && Math.abs(value) > 180;
  const rawLat = Number(contact.adv_lat);
  const rawLon = Number(contact.adv_lon);
  return {
    lat: isRawInt(rawLat) ? rawLat / 1e6 : rawLat,
    lon: isRawInt(rawLon) ? rawLon / 1e6 : rawLon,
  };
}

export interface ResolvedRadioHop {
  hash: string;
  contact?: Contact;
  hasCoordinates: boolean;
}

export function resolveRadioPath(
  hashes: string[],
  contacts: Contact[],
): ResolvedRadioHop[] {
  return hashes.map(hash => {
    const normalized = hash.toLowerCase().replace(/[^0-9a-f]/g, '');
    const matches = contacts.filter(contact => {
      const key = String(contact.public_key || '').toLowerCase();
      const prefix = String(contact.pubkey_prefix || '').toLowerCase();
      return normalized && (key.startsWith(normalized) || prefix.startsWith(normalized));
    });

    let contact: Contact | undefined;
    if (matches.length === 1) {
      contact = matches[0];
    } else if (matches.length > 1) {
      const located = matches.filter(hasCoordinates);
      if (located.length === 1) contact = located[0];
      else {
        contact = [...matches].sort((a, b) =>
          (Number(b.lastmod) || Number(b.last_advert) || 0)
          - (Number(a.lastmod) || Number(a.last_advert) || 0),
        )[0];
      }
    }

    return { hash, contact, hasCoordinates: Boolean(contact && hasCoordinates(contact)) };
  });
}
