// Adversary on 2934373 / 7160792 (Codex SIGNIN_R2 C1, 2026-10-07).
//
// Spec: "every scripts/*.mts release verifier must start; values from src/ come through a typed `createRequire`, and
// src/lib/__tests__/scripts-esm-imports.test.ts guards it."
//
// The guard (riskySrcImports) only recognises a src/ value import whose specifier is single-quoted AND spelled
// '../src/...'. Two other spellings take named values from src/ just the same and are missed:
//   1. the tsconfig path alias '@/...': tsx resolves it from the repo root (package.json runs every script there), so
//      `import { SAFE_FALLBACK_SLOT } from '@/lib/safe-authority-audit'` loads src/lib/safe-authority-audit.ts and dies
//      on its first line with the very error C1 is about. Proven below by running tsx on that one line.
//   2. a double-quoted '../src/...' specifier.
// Either one in a release verifier passes the guard and the verifier does not start.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { riskySrcImports } from './helpers/script-imports';

const ROOT = join(__dirname, '../../..');
const ALIAS_IMPORT = "import { SAFE_FALLBACK_SLOT } from '@/lib/safe-authority-audit';";

describe('scripts-esm-imports guard misses src/ named imports spelled another way (adversary on 2934373)', () => {
  it('the alias spelling really kills a script at start under tsx', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mako-adv-c1-'));
    try {
      const file = join(dir, 'probe.mts');
      writeFileSync(file, `${ALIAS_IMPORT}\nconsole.log('started', typeof SAFE_FALLBACK_SLOT);\n`);
      const run = spawnSync(join(ROOT, 'node_modules/.bin/tsx'), ['--tsconfig', join(ROOT, 'tsconfig.json'), file], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("does not provide an export named 'SAFE_FALLBACK_SLOT'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);

  it('the guard flags the alias spelling', () => {
    expect(riskySrcImports(ALIAS_IMPORT)).toHaveLength(1);
  });

  it('the guard flags a double-quoted ../src/ specifier', () => {
    expect(riskySrcImports('import { SAFE_FALLBACK_SLOT } from "../src/lib/safe-authority-audit.js";')).toHaveLength(1);
  });
});
