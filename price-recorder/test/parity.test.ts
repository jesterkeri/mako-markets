// CHARTS_DS_PLAN 15.3 item 2: the recorder's path (envelope split + the resolver's decodeVerified) gives the same
// fields as the decode checked against VerifierProxy.verify on Monad testnet for the same report
// (cf-worker/test/fixtures/btcusd-1789529160-verified.json, block 62922075). Item 1 holds by construction: the
// decoder IS the resolver's file. Item 3 (eth_call verify for every captured report) is a later network script.
import { describe, expect, it } from 'vitest';

import fixture from '../../cf-worker/test/fixtures/fixture-btcusd-1789529160.json';
import verified from '../../cf-worker/test/fixtures/btcusd-1789529160-verified.json';
import * as resolver from '../../cf-worker/src/datastreams';
import { reportBlob } from '../src/envelope';
import { validEntry } from '../src/entry';
import { feed } from './helpers';

describe('recorder decode == verifier-checked decode (BTC 2026-09-16 03:26:00 UTC, the 3-second window report)', () => {
  const entry = { feedID: fixture.feedID, validFromTimestamp: String(fixture.validFromTimestamp), observationsTimestamp: String(fixture.observationsTimestamp), fullReport: fixture.fullReport };
  it('every field the verified decode recorded', () => {
    const v = validEntry(entry, feed('BTC'));
    expect(v).not.toBeNull();
    const r = v!.report;
    expect(r.schema).toBe(3);
    if (r.schema !== 3) return;
    expect({ feedId: r.feedId, validFromTimestamp: r.validFromTimestamp, observationsTimestamp: r.observationsTimestamp, expiresAt: r.expiresAt, price: r.price.toString(), bid: r.bid.toString(), ask: r.ask.toString() }).toEqual({
      feedId: verified.feedId,
      validFromTimestamp: verified.validFromTimestamp,
      observationsTimestamp: verified.observationsTimestamp,
      expiresAt: verified.expiresAt,
      price: verified.price,
      bid: verified.bid,
      ask: verified.ask,
    });
  });
  it('the blob is the 288 bytes the verifier returned (its recorded size) and decodes with the resolver function itself', () => {
    const blob = reportBlob(entry.fullReport)!;
    expect((blob.length - 2) / 2).toBe(verified.decodedPayloadBytes);
    expect(resolver.decodeVerified(blob, 3)).toEqual(validEntry(entry, feed('BTC'))!.report);
  });
});
