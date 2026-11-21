// A SqlStorage for Node, over node:sqlite, so the settler's own code can run outside workerd against a real node.
// It implements only what src/settle.ts uses: exec(query, ...bindings) with toArray(), one() and rowsWritten.
import { DatabaseSync } from 'node:sqlite';

export function nodeSql(): SqlStorage {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const stmt = db.prepare(query);
    const reads = /^\s*(select|with|pragma)/i.test(query);
    let rows: Record<string, unknown>[] = [];
    let written = 0;
    if (reads) rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
    else written = Number(stmt.run(...(bindings as never[])).changes);
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
        return rows[0];
      },
      rowsWritten: written,
    };
  };
  return { exec } as unknown as SqlStorage;
}
