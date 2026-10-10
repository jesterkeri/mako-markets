// The authenticator setup screen (SignInDialog EnrollStep), tester feedback 2026-10-10: it says how long setup takes
// and why before it asks, names apps that work, and stays mandatory (no skip): the wallet is created only after this
// step (INBOX_GAP_PLAN [C5]). Read from source because reaching the step needs the full Privy email flow.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../../components/signin/SignInDialog.tsx', import.meta.url), 'utf8');
const start = src.indexOf('function EnrollStep(');
const step = src.slice(start, src.indexOf('\n}\n', start));
// The rendered text of the step: JSX text and string literals, comments dropped.
const copy = step
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/&apos;/g, '’')
  .replace(/\s+/g, ' ');

describe('authenticator setup copy', () => {
  it('is found', () => {
    expect(start).toBeGreaterThan(0);
  });
  it('says how long it takes and why, before the QR code', () => {
    const why = copy.indexOf('It protects your wallet if someone ever gets into your email');
    expect(copy).toContain('Takes about 30 seconds.');
    expect(why).toBeGreaterThan(0);
    expect(why).toBeLessThan(copy.indexOf('QRCodeSVG'));
  });
  it('names apps that work and how to keep codes', () => {
    for (const app of ['Google Authenticator', 'Authy', '1Password']) expect(copy).toContain(app);
    expect(copy).toContain('Turn on the app’s backup');
    // At most twice each: the list, then that app's own backup instruction (adversary on 1b06a62 found a repeated list).
    for (const app of ['Authy', '1Password']) expect(copy.split(app).length - 1).toBeLessThanOrEqual(2);
  });
  it('stays mandatory: no skip on this step', () => {
    expect(copy).not.toMatch(/\bskip\b|not now|later\b.*button/i);
    expect(copy).toContain('Turn on and continue');
  });
  it('follows the copy rules: no em dashes, no we/our/us', () => {
    expect(copy).not.toContain('—');
    expect(copy).not.toMatch(/\b(we|our|us)\b/i);
  });
});
