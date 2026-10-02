// Sends whose outcome is unknown: they may have gone out (a receipt timeout, a dropped connection after signing, a
// wallet error after broadcast). Reviewing the same send again is held once with a warning, so a second transfer is a
// deliberate choice. Kept in localStorage per account so a reload, a second tab or the back button does not release
// it (adversary on 6494c2b); in memory too, for browsers that block storage. Holds expire after an hour, by when the
// first send has either landed or been dropped.

export type SendHold = { to: string; amount: string; at: number; warned: boolean };

export const SEND_HOLD_TTL_MS = 60 * 60 * 1000;

const memory = new Map<string, SendHold[]>();
const keyOf = (account: string) => `mako.wallet.unresolved.${account.toLowerCase()}`;

function read(account: string, now: number): SendHold[] {
  const key = keyOf(account);
  let list: SendHold[];
  try {
    // Storage, when it can be read, is the record: it is what other tabs and a reload see.
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    list = Array.isArray(parsed)
      ? parsed.filter(
          (h): h is SendHold =>
            typeof h?.to === 'string' && typeof h?.amount === 'string' && typeof h?.at === 'number' && typeof h?.warned === 'boolean',
        )
      : [];
  } catch {
    // Storage blocked, or a malformed entry: the in-memory copy stands.
    list = memory.get(key) ?? [];
  }
  return list.filter((h) => now - h.at < SEND_HOLD_TTL_MS);
}

function write(account: string, list: SendHold[]) {
  const key = keyOf(account);
  memory.set(key, list);
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage blocked: the in-memory copy stands for this page.
  }
}

const same = (h: SendHold, to: string, amount: bigint) => h.to.toLowerCase() === to.toLowerCase() && h.amount === amount.toString();

/// Records a send whose outcome is unknown.
export function holdSend(account: string, to: string, amount: bigint, now = Date.now()) {
  const list = read(account, now).filter((h) => !same(h, to, amount));
  write(account, [...list, { to, amount: amount.toString(), at: now, warned: false }]);
}

/// Whether this send may go ahead. The first review of a held send is refused with `held`; the next review of the
/// same send is the deliberate second confirmation, which releases that hold and only that one.
export function checkHold(account: string, to: string, amount: bigint, now = Date.now()): 'clear' | 'held' {
  const list = read(account, now);
  const h = list.find((x) => same(x, to, amount));
  if (!h) return 'clear';
  if (!h.warned) {
    write(account, list.map((x) => (x === h ? { ...x, warned: true } : x)));
    return 'held';
  }
  write(account, list.filter((x) => x !== h));
  return 'clear';
}
