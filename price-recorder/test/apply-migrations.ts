// Every test starts from a freshly migrated local D1 (CHARTS_DS_PLAN 5.2): this plugin version keeps D1 storage
// between the tests of a file, so before each test every table is dropped and migrations/ is applied again.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

export async function freshDb(): Promise<void> {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  if (tables.results.length > 0) await env.DB.batch(tables.results.map((t) => env.DB.prepare(`DROP TABLE "${t.name}"`)));
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

beforeEach(freshDb);
