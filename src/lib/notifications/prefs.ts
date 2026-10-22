// ----------------------------------------------------------------------------
// #214 Notification preferences (NOTIFICATIONS_PLAN r8 §3.4).
//
// users.notification_prefs holds {"kinds": {<kind>: boolean}, "email": boolean}; NULL or anything malformed means
// the defaults. Nothing stored is trusted:
//   - SQL readers go through prefOn: a switch is cast only when it is a JSON boolean, anything else is the kind's
//     default. `->` on a non-object gives NULL, so an array, string or number at any level also gives the default.
//     A stored value can therefore never make a producer's transaction throw.
//   - TypeScript readers go through parsePrefs, which cannot throw.
//   - Every write goes through prefsSet (prefs POST now; unsubscribe and "Remind me" in later slices). It first
//     normalizes the stored value (not an object -> {}, a `kinds` that is not an object -> {}), then merges `kinds`
//     key by key, so only the named switches change and switched-off kinds stay off. A flat `||` (the chart-colours
//     merge) would replace the whole `kinds` object; jsonb_set returns NULL on NULL and does nothing under a missing
//     parent. The patch is built here from validated booleans, never from raw client JSON.
// ----------------------------------------------------------------------------

import { sql, type SQL } from 'drizzle-orm';

export const NOTIFICATION_KINDS = ['claim', 'result', 'reply', 'closing', 'round_start', 'price'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/// Money events default on; round reminders default off (owner Q5).
export const KIND_DEFAULTS: Readonly<Record<NotificationKind, boolean>> = {
  claim: true,
  result: true,
  reply: true,
  closing: true,
  round_start: false,
  price: true,
};

/// The email switch's default (S2 reads it; email accounts only).
export const EMAIL_DEFAULT = true;

export interface NotificationPrefs {
  kinds: Record<NotificationKind, boolean>;
  email: boolean;
}

export interface PrefsPatch {
  kinds?: Partial<Record<NotificationKind, boolean>>;
  email?: boolean;
}

export const isNotificationKind = (k: unknown): k is NotificationKind =>
  typeof k === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(k);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/// The effective switches for a stored value. Never throws; a non-boolean anywhere reads as that switch's default.
export function parsePrefs(raw: unknown): NotificationPrefs {
  const obj = isObject(raw) ? raw : {};
  const kinds = isObject(obj.kinds) ? obj.kinds : {};
  const out = {} as Record<NotificationKind, boolean>;
  for (const k of NOTIFICATION_KINDS) out[k] = typeof kinds[k] === 'boolean' ? (kinds[k] as boolean) : KIND_DEFAULTS[k];
  return { kinds: out, email: typeof obj.email === 'boolean' ? obj.email : EMAIL_DEFAULT };
}

/// SQL boolean: is `kind` switched on for the users row aliased `alias`. Casts only a JSON boolean.
export function prefOn(kind: NotificationKind, alias = 'u'): SQL {
  if (!isNotificationKind(kind) || !/^[a-z_]+$/.test(alias)) throw new Error('prefOn: bad kind or alias');
  const k = sql.raw(`'${kind}'`);
  const col = sql.raw(`${alias}.notification_prefs`);
  return sql`(CASE WHEN jsonb_typeof(${col}->'kinds'->${k}) = 'boolean'
    THEN (${col}->'kinds'->>${k})::boolean ELSE ${sql.raw(KIND_DEFAULTS[kind] ? 'true' : 'false')} END)`;
}

/// As prefOn, for a kind held in an SQL column (a batch insert's VALUES list). `kindCol` and `defaultCol` must be
/// trusted SQL (column references), never user input.
export function prefOnColumn(kindCol: SQL, defaultCol: SQL, alias = 'u'): SQL {
  if (!/^[a-z_]+$/.test(alias)) throw new Error('prefOnColumn: bad alias');
  const col = sql.raw(`${alias}.notification_prefs`);
  return sql`(CASE WHEN jsonb_typeof(${col}->'kinds'->${kindCol}) = 'boolean'
    THEN (${col}->'kinds'->>${kindCol})::boolean ELSE ${defaultCol} END)`;
}

/// Validates a patch from a request body. Only the six kinds, only booleans, at least one field; else null.
export function parsePrefsPatch(body: unknown): PrefsPatch | null {
  if (!isObject(body)) return null;
  const patch: PrefsPatch = {};
  if ('kinds' in body) {
    if (!isObject(body.kinds)) return null;
    const kinds: Partial<Record<NotificationKind, boolean>> = {};
    for (const [k, v] of Object.entries(body.kinds)) {
      if (!isNotificationKind(k) || typeof v !== 'boolean') return null;
      kinds[k] = v;
    }
    if (Object.keys(kinds).length > 0) patch.kinds = kinds;
  }
  if ('email' in body) {
    if (typeof body.email !== 'boolean') return null;
    patch.email = body.email;
  }
  return patch.kinds || patch.email !== undefined ? patch : null;
}

/// The SET value for users.notification_prefs that applies `patch` over whatever is stored (see the header).
export function prefsSet(patch: PrefsPatch): SQL {
  const kinds: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(patch.kinds ?? {})) {
    if (!isNotificationKind(k) || typeof v !== 'boolean') throw new Error('prefsSet: invalid kind patch');
    kinds[k] = v;
  }
  if (patch.email !== undefined && typeof patch.email !== 'boolean') throw new Error('prefsSet: invalid email patch');
  const top = patch.email === undefined ? {} : { email: patch.email };
  return sql`(CASE WHEN jsonb_typeof(notification_prefs) = 'object' THEN notification_prefs ELSE '{}'::jsonb END)
    || jsonb_build_object('kinds',
         (CASE WHEN jsonb_typeof(notification_prefs->'kinds') = 'object' THEN notification_prefs->'kinds' ELSE '{}'::jsonb END)
         || ${JSON.stringify(kinds)}::jsonb)
    || ${JSON.stringify(top)}::jsonb`;
}
