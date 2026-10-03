import { describe, it, expect } from 'vitest';
import {
  MESHCORE_PAYLOAD_TYPES,
  payloadTypeName,
  pathHashes,
  resolveRadioPath,
} from '../src/meshcore-radio';

const contact = (prefix: string, lat: number, lon: number, name = prefix) => ({
  public_key: prefix + 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  pubkey_prefix: prefix,
  added_to_node: true,
  adv_name: name,
  type: 1,
  flags: 0,
  adv_lat: lat,
  adv_lon: lon,
  lastmod: 1,
  last_advert: 1,
  out_path: '',
  out_path_len: 0,
  out_path_hash_mode: 2,
});

describe('MeshCore radio map helpers', () => {
  it('recognizes every defined payload type', () => {
    expect(Object.keys(MESHCORE_PAYLOAD_TYPES).map(Number)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15,
    ]);
    expect(payloadTypeName(1)).toBe('RESPONSE');
    expect(payloadTypeName(2)).toBe('TEXT_MSG');
    expect(payloadTypeName(8)).toBe('PATH');
    expect(payloadTypeName(15)).toBe('RAW_CUSTOM');
    expect(payloadTypeName(99)).toBe('UNKNOWN (99)');
  });

  it('parses a 2-byte, 5-hop path from decoded path_nodes', () => {
    const rx = {
      path_len: 5,
      path_hash_size: 2,
      path: 'e7130fb9ef1d22222121',
      parsed: {
        path_len: 5,
        path_hash_size: 2,
        path: 'e7130fb9ef1d22222121',
        path_nodes: ['e713', '0fb9', 'ef1d', '2222', '2121'],
      },
    };
    expect(pathHashes(rx)).toEqual(['e713', '0fb9', 'ef1d', '2222', '2121']);
  });

  it('parses a 2-byte, 6-hop path from the supplied packet', () => {
    const rx = {
      path_len: 6,
      path_hash_size: 2,
      path: 'e7130fb9d00bb7bfcfcc79d8',
    };
    expect(pathHashes(rx)).toEqual(['e713', '0fb9', 'd00b', 'b7bf', 'cfcc', '79d8']);
  });

  it('keeps DIRECT packets with path_len=0 as a valid empty route', () => {
    expect(pathHashes({
      path_len: 0,
      path_hash_size: 2,
      path: '',
    })).toEqual([]);
  });

  it('resolves known hashes to contacts and preserves unknown hops', () => {
    const contacts = [
      contact('e713', 52.1, 4.3, 'Node A'),
      contact('0fb9', 52.2, 4.4, 'Node B'),
      contact('ef1d', 52.3, 4.5, 'Node C'),
      contact('2222', 52.4, 4.6, 'Node D'),
    ];
    const resolved = resolveRadioPath(
      ['e713', '0fb9', 'missing', '2222'],
      contacts,
    );
    expect(resolved.map(hop => hop.contact?.adv_name)).toEqual([
      'Node A', 'Node B', undefined, 'Node D',
    ]);
    expect(resolved.map(hop => hop.hasCoordinates)).toEqual([
      true, true, false, true,
    ]);
  });

  it('does not treat zero coordinates as a mappable node', () => {
    const resolved = resolveRadioPath(
      ['e713'],
      [contact('e713', 0, 0)],
    );
    expect(resolved[0].hasCoordinates).toBe(false);
  });
});
