// Codex RELEASE_R5: both date-time forms use the one strict parser and never fail silently. The admin Mako form shows
// why a typed time was refused, blocks submit while it is, and shows why a submit was refused (its default times go
// stale while the page sits open). The Rounds schedule form uses the shared parser, not its own `new Date(v)`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('date-time inputs', () => {
  it('the admin Mako form reports refused times and refused submits', () => {
    const src = read('src/app/admin/create-mako/page.tsx');
    expect(src).not.toMatch(/console\.error\([^)]*validation failed/);
    expect(src).toMatch(/if \(validation\) \{\s*setSubmitError\(validation\);\s*return;/);
    expect(src.match(/localInputProblem\(e\.target\.value\)/g)).toHaveLength(2);
    expect(src).toMatch(/\|\| bettingTimeError !== null\s*\|\| closeTimeError !== null/);
    for (const v of ['submitError', 'bettingTimeError', 'closeTimeError']) {
      expect(src, v).toMatch(new RegExp(`\\{${v} && \\(\\s*<div role="alert"`));
    }
  });

  it('the Rounds schedule form uses the shared strict parser', () => {
    const src = read('src/app/rounds/new/ScheduleClient.tsx');
    expect(src).toContain("import { fromLocalInput, localInputProblem, toLocalInput } from '@/lib/datetime-local';");
    expect(src).not.toMatch(/function fromLocalInput|new Date\(v\)/);
    expect(src).toContain('localInputProblem(value)');
  });
});
