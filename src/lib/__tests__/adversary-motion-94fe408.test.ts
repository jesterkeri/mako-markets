// Adversary on feat/motion-pass@94fe408 (motion pass, Joshua 2026-10-16: "hover only for fine pointers").
//
// 94fe408 put `.mako-button--yes:hover` behind the fine-pointer gate, beside `.mako-button:hover` and
// `.mako-bet-tile:hover`. `.mako-button--ghost:hover` is still outside it: on a phone or tablet a tap leaves the
// button "hovered", so it keeps the raised background and the small brutal shadow after the finger lifts. Ghost buttons
// render on touch-reachable surfaces (WarningModal, profile IdentityBlock, TotpSection, WalletDriftBanner).

import { describe, expect, it } from 'vitest';

import { BRAND, inFineHover, rulesFor } from './helpers/motion-css';

describe('hover only for fine pointers (mako-brand.css)', () => {
  it('.mako-button--ghost:hover sets its shadow and background only behind the fine-pointer gate', () => {
    const rules = rulesFor(BRAND, '.mako-button--ghost:hover');
    const ungated = rules
      .filter((r) => !inFineHover(r.context) && (r.decls.has('box-shadow') || r.decls.has('background') || r.decls.has('transform')))
      .map((r) => `${r.selectors.join(', ')} { ${[...r.decls].map(([k, v]) => `${k}: ${v}`).join('; ')} } in [${r.context.join(' > ') || 'top level'}]`);
    expect(ungated, 'a hover effect a tap can leave stuck on').toEqual([]);
  });
});
