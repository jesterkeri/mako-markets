// The detector behind scripts-esm-imports.test.ts: every import statement that reads VALUES from src/ by name or as a
// namespace. src/ is reached as a relative path ('../src/...', any quote style) or through the tsconfig alias '@/...'
// (tsx resolves it from the repo root; adversary on 2934373). Default imports and type-only imports are fine.
export function riskySrcImports(source: string): string[] {
  const found: string[] = [];
  const re = /^import\s+(type\s+)?([^'";]*?)\s+from\s+(['"])((?:\.{1,2}\/)+src\/[^'"]+|@\/[^'"]+)\3;?/gms;
  for (const m of source.matchAll(re)) {
    if (m[1]) continue; // `import type ...`: erased
    const clause = m[2].trim();
    const braces = clause.match(/\{([^}]*)\}/);
    const named = braces
      ? braces[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type '))
      : [];
    if (named.length > 0 || /\*\s+as\s+/.test(clause)) found.push(`${clause} from '${m[4]}'`);
  }
  return found;
}
