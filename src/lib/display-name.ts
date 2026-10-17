// Display names are unique, case-insensitively (Joshua 2026-10-17): the server's checks, the database rule and the Me
// page's live check all use these. The database stores each name's key in users.display_name_key (migration 0017),
// unique when set; the SQL in that migration computes the same key as displayNameKey.

export const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]{1,32}$/;

/// The form two names are compared in: trimmed, inner spaces collapsed, lower case ("Jester  Z " -> "jester z").
export const displayNameKey = (name: string): string => name.trim().replace(/ +/g, ' ').toLowerCase();

// Names nobody can take, so no one can pose as the platform. Compared with spaces, dots, underscores and dashes removed.
const RESERVED = new Set(['mako', 'makomarket', 'makomarkets', 'admin', 'administrator', 'support', 'official', 'moderator', 'mod', 'staff', 'team', 'system']);

export const isReservedDisplayName = (name: string): boolean => RESERVED.has(displayNameKey(name).replace(/[ ._-]/g, ''));
