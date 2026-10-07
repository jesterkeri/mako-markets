// Release scripts (scripts/*.mts) are ES modules; src/ loads as CommonJS under tsx, where Node GUESSES an ES module's
// named imports and misses some, so a script can die on its first line ("does not provide an export named ...": the
// pre-beta audit on 2026-10-07, then verify:safe in Codex SIGNIN_R2 C1). Every value a script takes from src/ must come
// from the whole module (`import lib from '../src/...'; const { x } = lib;`). Type-only imports are erased and fine.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { riskySrcImports } from './helpers/script-imports';

const DIR = join(__dirname, '../../../scripts');

describe('scripts/*.mts take values from src/ only as whole modules', () => {
  it('the detector catches named and namespace imports and allows default and type-only ones', () => {
    expect(riskySrcImports("import { a, b } from '../src/lib/x';")).toHaveLength(1);
    expect(riskySrcImports("import {\n  a,\n  b,\n} from '../src/lib/x.js';")).toHaveLength(1);
    expect(riskySrcImports("import * as schema from '../src/db/schema.js';")).toHaveLength(1);
    expect(riskySrcImports("import lib, { a } from '../src/lib/x';")).toHaveLength(1);
    expect(riskySrcImports("import lib from '../src/lib/x';")).toHaveLength(0);
    expect(riskySrcImports("import lib, { type T } from '../src/lib/x';")).toHaveLength(0);
    expect(riskySrcImports("import type { T } from '../src/lib/x';")).toHaveLength(0);
    expect(riskySrcImports("import { a } from 'viem';")).toHaveLength(0);
    // Adversary on 2934373: the tsconfig alias and double quotes reach src/ too.
    expect(riskySrcImports("import { a } from '@/lib/x';")).toHaveLength(1);
    expect(riskySrcImports('import { a } from "../src/lib/x.js";')).toHaveLength(1);
    expect(riskySrcImports('import * as s from "@/db/schema";')).toHaveLength(1);
    expect(riskySrcImports("import type { T } from '@/lib/x';")).toHaveLength(0);
  });

  it('no script does it', () => {
    const offenders = readdirSync(DIR)
      .filter((f) => f.endsWith('.mts'))
      .flatMap((f) => riskySrcImports(readFileSync(join(DIR, f), 'utf8')).map((i) => `${f}: ${i}`));
    expect(offenders).toEqual([]);
  });
});
