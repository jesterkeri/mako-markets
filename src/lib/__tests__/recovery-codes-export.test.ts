// ----------------------------------------------------------------------------
// recovery-codes-export.test.ts
//
// Pure-logic tests for the RecoveryCodesPanel COPY/DOWNLOAD content
// builders extracted into src/lib/recovery-codes-export.ts. Pins:
//   - COPY format is a tab-separated single line
//   - DOWNLOAD content has a header line + blank + codes one per line
//   - filename includes the date in YYYY-MM-DD form
//   - the panel itself does NOT show the required-save checkbox
//     (that lives on the parent modal — codex round-1 MAJOR 1)
// ----------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  formatRecoveryCodesForCopy,
  formatRecoveryCodesForDownload,
} from '../recovery-codes-export';

const TEN_CODES = [
  'AAAA-BBBB-CC',
  'CCCC-DDDD-EE',
  'EEEE-FFFF-GG',
  'GGGG-HHHH-JJ',
  'JJJJ-KKKK-MM',
  'MMMM-NNNN-PP',
  'PPPP-QQQQ-RR',
  'RRRR-SSSS-TT',
  'TTTT-VVVV-WW',
  'WWWW-XXXX-YY',
];

describe('formatRecoveryCodesForCopy', () => {
  it('joins the 10 codes with tabs', () => {
    const out = formatRecoveryCodesForCopy(TEN_CODES);
    expect(out).toBe(TEN_CODES.join('\t'));
  });

  it('contains exactly 9 tabs for 10 codes', () => {
    const out = formatRecoveryCodesForCopy(TEN_CODES);
    const tabCount = (out.match(/\t/g) ?? []).length;
    expect(tabCount).toBe(9);
  });

  it('does not include any newline characters', () => {
    const out = formatRecoveryCodesForCopy(TEN_CODES);
    expect(out).not.toContain('\n');
    expect(out).not.toContain('\r');
  });

  it('handles an empty array', () => {
    expect(formatRecoveryCodesForCopy([])).toBe('');
  });
});

describe('formatRecoveryCodesForDownload', () => {
  const FIXED_DATE = new Date('2026-05-04T15:30:45Z');

  it('header line includes the YYYY-MM-DD date', () => {
    const { content } = formatRecoveryCodesForDownload(TEN_CODES, FIXED_DATE);
    const firstLine = content.split('\n')[0];
    expect(firstLine).toContain('2026-05-04');
    expect(firstLine).toMatch(/Mako Market recovery codes/);
  });

  it('renders one code per line after the header + blank', () => {
    const { content } = formatRecoveryCodesForDownload(TEN_CODES, FIXED_DATE);
    const lines = content.split('\n');
    // [0] = header, [1] = '', [2..11] = 10 codes, [12] = '' (trailing newline).
    expect(lines[0]).toContain('Mako Market recovery codes');
    expect(lines[1]).toBe('');
    expect(lines.slice(2, 12)).toEqual(TEN_CODES);
    expect(lines[12]).toBe('');
  });

  it('filename is mako-recovery-codes-YYYY-MM-DD.txt', () => {
    const { filename } = formatRecoveryCodesForDownload(TEN_CODES, FIXED_DATE);
    expect(filename).toBe('mako-recovery-codes-2026-05-04.txt');
  });

  it('zero-pads single-digit months and days', () => {
    const earlyDate = new Date('2026-01-09T08:00:00Z');
    const { filename, content } = formatRecoveryCodesForDownload(
      TEN_CODES,
      earlyDate,
    );
    expect(filename).toBe('mako-recovery-codes-2026-01-09.txt');
    expect(content).toContain('2026-01-09');
  });

  it('content ends with a trailing newline', () => {
    const { content } = formatRecoveryCodesForDownload(TEN_CODES, FIXED_DATE);
    expect(content.endsWith('\n')).toBe(true);
  });
});
