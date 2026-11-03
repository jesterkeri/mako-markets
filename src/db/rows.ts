/// The rows of a `db.execute` result: node-postgres and pglite return `{ rows }`, postgres-js returns the array itself.
/// No `server-only` import, so scripts run under tsx can use it.
export const rowsOf = <T>(res: unknown): T[] => {
  const raw = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
  return (Array.isArray(raw) ? raw : []) as T[];
};
