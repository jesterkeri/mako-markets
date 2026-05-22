import { afterEach, describe, expect, it } from 'vitest';
import { isPmEnabled } from '../pm-enabled';

const KEY = 'NEXT_PUBLIC_PM_ENABLED';
const original = process.env[KEY];

function restore(): void {
  // `process.env[KEY] = undefined` stringifies to the literal
  // "undefined" — env vars are always strings. Use delete when
  // the captured original was unset.
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
}

describe('isPmEnabled — strict literal-true gate', () => {
  afterEach(restore);

  it('returns true only for literal "true"', () => {
    process.env[KEY] = 'true';
    expect(isPmEnabled()).toBe(true);
  });

  const falsyCases: Array<{ val: string | undefined; label: string }> = [
    { val: undefined, label: 'unset' },
    { val: '', label: 'empty string' },
    { val: 'false', label: 'literal "false"' },
    { val: 'TRUE', label: 'uppercase TRUE' },
    { val: '1', label: 'numeric 1' },
    { val: '0', label: 'numeric 0' },
    { val: 'yes', label: 'truthy-ish word' },
    { val: 'enable', label: 'imperative word' },
  ];
  it.each(falsyCases)('returns false for $label', ({ val }) => {
    if (val === undefined) delete process.env[KEY];
    else process.env[KEY] = val;
    expect(isPmEnabled()).toBe(false);
  });
});
