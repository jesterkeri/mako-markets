// Display names are unique, case-insensitively (Joshua 2026-10-17): the server's checks, the database rule and the Me
// page's live check all use these. The database stores each name's key in users.display_name_key (migration 0017),
// unique when set; the SQL in that migration computes the same key as displayNameKey.

export const DISPLAY_NAME_RE = /^[A-Za-z0-9 ._-]{1,32}$/;

/// The form two names are compared in: trimmed, inner spaces collapsed, lower case ("Jester  Z " -> "jester z").
export const displayNameKey = (name: string): string => name.trim().replace(/ +/g, ' ').toLowerCase();

// Names nobody can take, so no one can pose as the platform: a name made only of the platform's name and role words
// ("Mako", "Mako Official", "Support Team", "MakoSupport"), compared by whole words, so "Makoto" or "Happy" are fine.
const BRAND = ['mako', 'makomarket', 'makomarkets'];
const ROLES = ['official', 'team', 'support', 'admin', 'administrator', 'staff', 'mod', 'moderator', 'market', 'markets', 'app', 'hq', 'bot', 'system', 'help'];
const WORDS = new Set([...BRAND, ...ROLES]);

export const isReservedDisplayName = (name: string): boolean => {
  const words = displayNameKey(name).split(/[ ._-]+/).filter(Boolean);
  if (words.length > 0 && words.every((w) => WORDS.has(w))) return true;
  // One run-together word: a brand name joined to a role ("makosupport", "supportmako", "makomarketofficial").
  const bare = words.join('');
  return BRAND.some((b) => bare === b || ROLES.some((r) => bare === b + r || bare === r + b));
};
