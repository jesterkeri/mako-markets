import { describe, expect, it } from 'vitest';

import { explorerUrl } from '../chain';
import { CIRCLE_FAUCET_URL, listStateCopy, type ListKind } from '../list-states';
import manifest from '../mascot-manifest.json';

const KINDS: ListKind[] = ['rounds', 'pools', 'me'];
const all = [...KINDS.flatMap((k) => [listStateCopy(k, 'empty'), listStateCopy(k, 'error', explorerUrl('address', '0xabc'))]), listStateCopy('rounds', 'not_open')];
const text = (c: ReturnType<typeof listStateCopy>) =>
  [c.title, c.body, c.footer ?? '', c.primary.label, c.secondary.label].join(' ');

describe('list state copy', () => {
  it('keeps shipped-copy rules: no em-dash, no we/our/us, brand singular', () => {
    for (const c of all) {
      const t = text(c);
      expect(t).not.toMatch(/—/);
      expect(t).not.toMatch(/\b(we|our|us|team)\b/i);
      expect(t).not.toMatch(/Mako Markets/);
    }
  });

  it('makes no promise the product cannot keep', () => {
    for (const c of all) {
      const t = text(c);
      expect(t).not.toMatch(/every few minutes/i); // rounds exist only when a creator schedules one
      expect(t).not.toMatch(/10 (free )?test USDC/i); // the faucet is Circle's; no amount promised
      expect(t).not.toMatch(/turn on a reminder/i); // reminders need notifications, not built yet
    }
  });

  it('sends Me to Circle’s faucet as an external link', () => {
    expect(listStateCopy('me', 'empty').primary).toEqual({ label: 'Get test USDC', href: CIRCLE_FAUCET_URL, external: true });
  });

  it('shows Remind me as coming soon, not as a working button', () => {
    expect(listStateCopy('rounds', 'empty').secondary).toEqual({ label: 'Remind me', comingSoon: true });
  });

  it('every error offers Try again and says nothing was lost or everything is safe', () => {
    for (const k of KINDS) {
      const c = listStateCopy(k, 'error');
      expect(c.primary).toEqual({ label: 'Try again', retry: true });
      expect(c.body).toMatch(/safe on-chain/);
      expect(c.pose).toBe('20-error-cable');
    }
  });

  it('offers the account on the explorer only on Me, and only when given', () => {
    const href = explorerUrl('address', '0xabc');
    expect(listStateCopy('me', 'error', href).secondary).toEqual({ label: 'View on explorer', href, external: true });
    expect(listStateCopy('me', 'error').secondary).toEqual({ label: 'Go home', href: '/' });
    expect(listStateCopy('pools', 'error', href).secondary).toEqual({ label: 'Go home', href: '/' });
  });

  it('uses only poses that exist on Blob', () => {
    for (const c of all) expect(Object.keys(manifest.poses)).toContain(c.pose);
  });
});

describe('explorerUrl', () => {
  it('points at MonadVision', () => {
    expect(explorerUrl('tx', '0x12')).toBe('https://testnet.monadvision.com/tx/0x12');
    expect(explorerUrl('address', '0xab')).toBe('https://testnet.monadvision.com/address/0xab');
  });
});
