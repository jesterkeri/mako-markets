// ----------------------------------------------------------------------------
// src/lib/recent-emails.ts
//
// Browser-only memory of recently signed-in email addresses, persisted in
// localStorage. Powers the "switch back" affordance on /signup so a user
// who switches accounts can return to a prior email with one tap rather
// than re-typing it.
//
// Threat model: localStorage is per-origin and per-browser. The data here
// is a list of email addresses the user already typed into Mako's sign-in
// flow on this device — strictly less sensitive than the active session
// cookie. We do NOT store DID tokens, passwords, signing keys, or any
// material that could be used to authenticate. Listing emails is a
// convenience, not a credential.
//
// Bounds:
//   - Max RECENT_EMAILS_LIMIT entries; oldest evicted on overflow.
//   - Most-recent-first order. addRecent moves an existing email to the
//     head rather than duplicating.
//   - Emails are normalized (lowercased + trimmed) before storage so
//     "Foo@bar.com" and "foo@bar.com" don't both occupy slots.
//
// All public functions are SSR-safe — they no-op when `window` is
// undefined so the module can be imported by mixed server/client code.
// ----------------------------------------------------------------------------

const STORAGE_KEY = 'mako:recent_emails';
const RECENT_EMAILS_LIMIT = 5;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function readRaw(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .slice(0, RECENT_EMAILS_LIMIT);
  } catch {
    // Corrupted JSON, quota exceeded read, or some browser extension
    // shimming localStorage with a strict contract. Treat as empty —
    // recent-emails is convenience-only, never a hard dependency.
    return [];
  }
}

function writeRaw(list: string[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, RECENT_EMAILS_LIMIT)));
  } catch {
    // Quota exceeded or storage disabled. Failing silently is correct
    // for a convenience feature — the user can still type the email.
  }
}

/// Read the recent-emails list, most recent first.
export function getRecentEmails(): string[] {
  return readRaw();
}

/// Push an email to the head of the list. If it already exists, it
/// moves to the head (no duplicate). Oldest entries beyond
/// RECENT_EMAILS_LIMIT are evicted.
export function addRecentEmail(email: string): void {
  const normalized = normalize(email);
  if (!normalized || !normalized.includes('@')) return;
  const existing = readRaw().filter((e) => e !== normalized);
  writeRaw([normalized, ...existing]);
}

/// Remove a specific email from the recent list. Used by a future "X"
/// affordance on the /signup recent-emails picker.
export function removeRecentEmail(email: string): void {
  const normalized = normalize(email);
  if (!normalized) return;
  const filtered = readRaw().filter((e) => e !== normalized);
  writeRaw(filtered);
}
