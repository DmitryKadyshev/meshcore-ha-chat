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
    if (pathLen && path.length % pathLen === 0) hashWidth = path.length / pathLen;
  }
  if (!hashWidth || !Number.isInteger(hashWidth) || hashWidth < 2 || hashWidth > 6) {
    hashWidth = path.length % 6 === 0 ? 6 : path.length % 4 === 0 ? 4 : 2;
  }

  const hashes: string[] = [];
  for (let i = 0; i + hashWidth <= path.length; i += hashWidth) {
    hashes.push(path.slice(i, i + hashWidth));
  }
  return hashes;
}

export function hasCoordinates(contact: Contact): boolean {
  return Number.isFinite(contact.adv_lat)
    && Number.isFinite(contact.adv_lon)
    && Math.abs(contact.adv_lat) <= 90
    && Math.abs(contact.adv_lon) <= 180
    && !(contact.adv_lat === 0 && contact.adv_lon === 0);
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
