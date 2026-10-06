// ----------------------------------------------------------------------------
// src/lib/privy-config-check.ts
//
// The Privy app's settings as a checked release artifact (INBOX_GAP_PLAN r18 [M5], [B1], [B5], [C5], [C7], [D3]).
// Pure: scripts/check-privy-config.ts reads the settings with the app secret (Joshua's shell) and prints this verdict.
// A release needs a passing run from the same day, for the production app and for the development app.
// ----------------------------------------------------------------------------

/// The parts of `@privy-io/node` AppResponse this check reads.
export interface PrivyAppSettings {
  id: string;
  allowed_domains: string[];
  allowed_native_app_ids: string[];
  allowed_native_app_url_schemes: string[];
  mfa_methods: string[];
  passkey_auth: boolean;
  passkeys_for_signup_enabled: boolean;
  email_auth: boolean;
  merge_accounts_by_email: boolean;
  embedded_wallet_config: {
    create_on_login: string;
    ethereum: { create_on_login: string };
    solana: { create_on_login: string };
    mode?: string;
    user_owned_recovery_options?: string[];
  };
  max_linked_wallets_per_user?: number | null;
  /// Every other login method, true when on; all must be off ([C7]).
  [loginMethod: string]: unknown;
}

/// Every login method besides email that the settings carry as a boolean ([C7]: email is the only way in).
export const OTHER_LOGIN_METHODS = [
  'wallet_auth',
  'solana_wallet_auth',
  'sms_auth',
  'guest_auth',
  'custom_jwt_auth',
  'farcaster_auth',
  'telegram_auth',
  'apple_oauth',
  'discord_oauth',
  'github_oauth',
  'google_oauth',
  'instagram_oauth',
  'line_oauth',
  'linkedin_oauth',
  'spotify_oauth',
  'tiktok_oauth',
  'twitch_oauth',
  'twitter_oauth',
  'telegram_oauth',
] as const;

/// The reviewed allowed-domain lists ([M5], [C7]). Changing them is a reviewed change to this file.
export const EXPECTED_DOMAINS = {
  production: ['https://makomarket.xyz'],
  development: ['https://beta.makomarket.xyz', 'http://localhost:3001'],
} as const;

export type AppRole = keyof typeof EXPECTED_DOMAINS;

export interface ConfigVerdict {
  ok: boolean;
  failures: string[];
  /// Recorded with the evidence, not judged here: the wallet mode the matrix was proven on, and the recovery options.
  recorded: Record<string, unknown>;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function checkPrivyAppConfig(s: PrivyAppSettings, role: AppRole, expectedAppId: string, expectedMode?: string): ConfigVerdict {
  const f: string[] = [];
  if (s.id !== expectedAppId) f.push(`app id is ${s.id}, expected the ${role} app ${expectedAppId}`);
  if (!sameSet(s.mfa_methods, ['totp'])) f.push(`mfa_methods must be exactly [totp], is [${s.mfa_methods.join(', ')}]`);
  if (s.passkey_auth) f.push('passkey login (passkey_auth) must be off [B1]');
  if (s.passkeys_for_signup_enabled) f.push('passkeys for signup must be off [B1]');
  if (!s.email_auth) f.push('email login must be on');
  for (const m of OTHER_LOGIN_METHODS) if (s[m] === true) f.push(`${m} must be off: email is the only login method [C7]`);
  if (s.merge_accounts_by_email) f.push('merge_accounts_by_email must be off [D3]');
  if (s.allowed_native_app_ids.length > 0) f.push('allowed_native_app_ids must be empty (no native app) [B5]');
  if (s.allowed_native_app_url_schemes.length > 0) f.push('allowed_native_app_url_schemes must be empty [B5]');
  const w = s.embedded_wallet_config;
  if (w.create_on_login !== 'off') f.push(`embedded wallet create_on_login must be off, is ${w.create_on_login} [C5]`);
  if (w.ethereum.create_on_login !== 'off') f.push(`ethereum create_on_login must be off, is ${w.ethereum.create_on_login} [C5]`);
  if (w.solana.create_on_login !== 'off') f.push(`solana create_on_login must be off, is ${w.solana.create_on_login} [D3]`);
  if (expectedMode !== undefined && w.mode !== expectedMode) f.push(`embedded wallet mode is ${w.mode}, expected ${expectedMode} (the mode the matrix was proven on) [A3] [D1]`);
  const expected = EXPECTED_DOMAINS[role];
  if (s.allowed_domains.length === 0) f.push('allowed_domains must not be empty');
  if (s.allowed_domains.some((d) => d.includes('*'))) f.push('allowed_domains must not contain a wildcard');
  if (!sameSet(s.allowed_domains, expected)) f.push(`allowed_domains must be exactly [${expected.join(', ')}], is [${s.allowed_domains.join(', ')}]`);
  return {
    ok: f.length === 0,
    failures: f,
    recorded: {
      mode: w.mode ?? null,
      user_owned_recovery_options: w.user_owned_recovery_options ?? [],
      max_linked_wallets_per_user: s.max_linked_wallets_per_user ?? null,
    },
  };
}
