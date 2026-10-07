// Adversary on 2934373 / 7160792 (Codex SIGNIN_R2 C1, 2026-10-07).
//
// Spec: "every scripts/*.mts release verifier must start; values from src/ come through a typed `createRequire`, and
// src/lib/__tests__/scripts-esm-imports.test.ts guards it."
//
// The guard (riskySrcImports) only recognises a src/ value import whose specifier is single-quoted AND spelled
// '../src/...'. Two other spellings take named values from src/ just the same and are missed:
//   1. the tsconfig path alias '@/...': tsx resolves it from the repo root (package.json runs every script there), so
//      `import { SAFE_FALLBACK_SLOT } from '@/lib/safe-authority-audit'` loads src/lib/safe-authority-audit.ts and dies
//      on its first line with the very error C1 is about (shown locally by running tsx on that line; see below).
//   2. a double-quoted '../src/...' specifier.
// Either one in a release verifier passes the guard and the verifier does not start.
import { describe, expect, it } from 'vitest';

import { riskySrcImports } from './helpers/script-imports';

const ALIAS_IMPORT = "import { SAFE_FALLBACK_SLOT } from '@/lib/safe-authority-audit';";

// The runtime proof (tsx on the alias line) was removed from CI on 2026-10-07: it crashed with "does not provide an
// export named 'SAFE_FALLBACK_SLOT'" locally (Node 22.23.2) but started on CI's Node. That difference is the C1 point
// itself: whether Node detects a CommonJS named export depends on the environment, so a script must not rely on it.
describe('scripts-esm-imports guard misses src/ named imports spelled another way (adversary on 2934373)', () => {
  it('the guard flags the alias spelling', () => {
    expect(riskySrcImports(ALIAS_IMPORT)).toHaveLength(1);
  });

  it('the guard flags a double-quoted ../src/ specifier', () => {
    expect(riskySrcImports('import { SAFE_FALLBACK_SLOT } from "../src/lib/safe-authority-audit.js";')).toHaveLength(1);
  });
});
