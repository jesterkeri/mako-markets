// Display names are unique, case-insensitively (Joshua 2026-10-17): the server's checks, the database rule and the Me
// page's live check all use these. The database stores each name's key in users.display_name_key (migration 0017),
// unique when set; the SQL in that migration computes the same key as displayNameKey.

export const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]{1,32}$/;

/// The form two names are compared in: trimmed, inner spaces collapsed, lower case ("Jester  Z " -> "jester z").
export const displayNameKey = (name: string): string => name.trim().replace(/ +/g, ' ').toLowerCase();

// Names nobody can take, so no one can pose as the platform: a name made only of the platform's name and role words
// ("Mako", "Mako Official", "Support Team", "MakoSupportTeam"); "Makoto" or "Happy" are fine (not made only of them).
const BRAND = ['mako', 'makomarket', 'makomarkets'];
const ROLES = ['official', 'team', 'support', 'admin', 'administrator', 'staff', 'mod', 'moderator', 'market', 'markets', 'app', 'hq', 'bot', 'system', 'help'];
const WORDS = new Set([...BRAND, ...ROLES]);

// The whole name, with spaces, dots, underscores and dashes removed, is a run of those words.
const ONLY_WORDS = new RegExp(`^(?:${[...WORDS].sort((a, b) => b.length - a.length).join('|')})+$`);

export const isReservedDisplayName = (name: string): boolean => ONLY_WORDS.test(displayNameKey(name).replace(/[ ._-]/g, ''));
