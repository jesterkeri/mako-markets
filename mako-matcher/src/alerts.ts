// Alerts (Phase A): a line on the Worker log and a row in the Durable Object's own bounded table. Delivery to
// Telegram is the operations track's (the watchdog does it today); nothing here reaches outside the Worker.
import { MAX_ALERT_ROWS } from './config';

export type Alert = (code: string, detail: string) => void;

export function makeAlert(sql: SqlStorage, now: () => number, log: (line: string) => void): Alert {
  return (code, detail) => {
    // Bound the text and strip anything unprintable; nothing from a request belongs in an alert unread.
    const d = detail.slice(0, 300).replace(/[^\x20-\x7e]/g, '');
    log(JSON.stringify({ matcherAlert: code, detail: d }));
    try {
      sql.exec(`INSERT INTO alerts (at, code, detail) VALUES (?, ?, ?)`, now(), code, d);
      sql.exec(`DELETE FROM alerts WHERE id <= (SELECT MAX(id) FROM alerts) - ?`, MAX_ALERT_ROWS);
    } catch {
      /* the log line above is the fallback */
    }
  };
}
