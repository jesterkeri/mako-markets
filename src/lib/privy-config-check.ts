// ----------------------------------------------------------------------------
// src/lib/privy-config-check.ts
//
// The Privy app's settings as a checked release artifact (INBOX_GAP_PLAN r18 [M5], [B1], [B5], [C5], [C7], [D3]).
// Pure: scripts/check-privy-config.ts reads the settings with the app secret (Joshua's shell) and prints this verdict.
// A release needs a passing run from the same day, for the production app and for the development app.
//
// A pass must PROVE each setting, never assume it (Codex release-gates review, F1 and F3):
// - The answer is parsed at runtime. A security-relevant field that is absent or of the wrong type is a failure, not
//   "off": a partial or changed API response cannot pass as a secure one.
// - The wallet mode is compared with EXPECTED_WALLET_MODE, a reviewed constant in this file, for both apps. There is
//   no way to run the check without it.
// ----------------------------------------------------------------------------

import { z } from 'zod';

/// [A3] [D1]: the embedded wallet mode the development app runs and the live matrix (mako-design INBOX_LIVE_RUNBOOK.md
/// L1 to L9) is proven on. It decides where Privy enforces MFA and whether wallets share entropy. Pinned 2026-10-07
/// from the evidence: the live test passed (L1-L4, L6, L8, L9) on the development app cmumupole01p20bl20bvn4ikf, whose
/// config check that day recorded mode "user-controlled-server-wallets-only". Both apps must match it exactly; changing
/// it is a reviewed change that needs the live test run again on the new mode.
export const EXPECTED_WALLET_MODE: string | null = 'user-controlled-server-wallets-only';

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

/// Sign-up and seamless switches that are another way in ([C7]).
export const OTHER_SIGNUP_FLAGS = ['whatsapp_enabled', 'external_wallets_for_signup_enabled'] as const;

/// The reviewed allowed-domain lists ([M5], [C7]). Changing them is a reviewed change to this file.
export const EXPECTED_DOMAINS = {
  production: ['https://makomarket.xyz'],
  development: ['https://beta.makomarket.xyz', 'http://localhost:3001'],
} as const;

export type AppRole = keyof typeof EXPECTED_DOMAINS;

const strings = z.array(z.string());
const createOnLogin = z.string();

/// Every field the verdict depends on, required and typed as @privy-io/node 0.35.0 AppResponse declares it
/// (resources/apps/apps.d.ts). Unknown extra fields pass through, so a new `*_auth`/`*_oauth` switch is still seen.
const SettingsSchema = z
  .object({
    id: z.string(),
    allowed_domains: strings,
    allowed_native_app_ids: strings,
    allowed_native_app_url_schemes: strings,
    mfa_methods: strings,
    passkey_auth: z.boolean(),
    passkeys_for_signup_enabled: z.boolean(),
    email_auth: z.boolean(),
    merge_accounts_by_email: z.boolean(),
    custom_oauth_providers: z.array(z.object({ enabled: z.boolean(), provider: z.string() }).passthrough()),
    max_linked_wallets_per_user: z.number().nullable(),
    // Telegram seamless login is declared in two optional places (apps.d.ts: `telegram_seamless_auth_enabled?` and
    // `telegram_auth_config?.seamless_auth_enabled`). Each that is present must be a boolean; at least one must be
    // present for it to be proven off (adversary on 0f4e0f9), judged below.
    telegram_seamless_auth_enabled: z.boolean().optional(),
    telegram_auth_config: z.object({ seamless_auth_enabled: z.boolean() }).passthrough().optional(),
    embedded_wallet_config: z
      .object({
        create_on_login: createOnLogin,
        ethereum: z.object({ create_on_login: createOnLogin }).passthrough(),
        solana: z.object({ create_on_login: createOnLogin }).passthrough(),
        mode: z.string(),
        user_owned_recovery_options: strings,
      })
      .passthrough(),
    ...Object.fromEntries(OTHER_LOGIN_METHODS.map((m) => [m, z.boolean()])),
    ...Object.fromEntries(OTHER_SIGNUP_FLAGS.map((m) => [m, z.boolean()])),
  })
  .passthrough();

export type PrivyAppSettings = z.input<typeof SettingsSchema>;

export interface ConfigVerdict {
  ok: boolean;
  failures: string[];
  /// Recorded with the evidence, not judged here: the wallet mode, the recovery options, the linked-wallet cap.
  recorded: Record<string, unknown>;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/// The verdict on a settings answer. `expectedMode` is required: the CLI passes EXPECTED_WALLET_MODE, and `null` (not
/// pinned yet) is a failure that names the mode the app reports.
export function checkPrivyAppConfig(raw: unknown, role: AppRole, expectedAppId: string, expectedMode: string | null): ConfigVerdict {
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const failures = parsed.error.issues.map((i) => `${i.path.join('.') || '(answer)'} is missing or malformed (${i.message}): it cannot be proven [M5]`);
    return { ok: false, failures, recorded: {} };
  }
  const s = parsed.data as z.output<typeof SettingsSchema> & Record<string, unknown>;
  const f: string[] = [];
  if (s.id !== expectedAppId) f.push(`app id is ${s.id}, expected the ${role} app ${expectedAppId}`);
  if (!sameSet(s.mfa_methods, ['totp'])) f.push(`mfa_methods must be exactly [totp], is [${s.mfa_methods.join(', ')}]`);
  if (s.passkey_auth !== false) f.push('passkey login (passkey_auth) must be off [B1]');
  if (s.passkeys_for_signup_enabled !== false) f.push('passkeys for signup must be off [B1]');
  if (s.email_auth !== true) f.push('email login must be on');
  for (const m of OTHER_LOGIN_METHODS) if (s[m] !== false) f.push(`${m} must be off: email is the only login method [C7]`);
  // Fail closed on any login switch this list does not name yet (Privy adds providers): every *_auth / *_oauth flag that
  // is on, other than email, is another way in.
  // Only a literal `false` proves an unlisted switch off: "true", 1 or an object is on or unknown (adversary on 0f4e0f9).
  for (const [k, v] of Object.entries(s)) {
    if (v !== false && /(_auth|_oauth)$/.test(k) && k !== 'email_auth' && !(OTHER_LOGIN_METHODS as readonly string[]).includes(k)) {
      f.push(`${JSON.stringify(k)} must be off (is ${JSON.stringify(v)}): email is the only login method [C7]`);
    }
  }
  // Custom OAuth providers are a list, not a flag (adversary on e1e0679): any enabled one is another way in.
  for (const p of s.custom_oauth_providers) if (p.enabled !== false) f.push(`custom OAuth provider ${JSON.stringify(p.provider)} must be off [C7]`);
  for (const k of OTHER_SIGNUP_FLAGS) if (s[k] !== false) f.push(`${k} must be off: email is the only login method [C7]`);
  const seamless = [s.telegram_seamless_auth_enabled, s.telegram_auth_config?.seamless_auth_enabled].filter((v) => v !== undefined);
  if (seamless.length === 0) f.push('Telegram seamless login is absent from the answer (telegram_seamless_auth_enabled and telegram_auth_config.seamless_auth_enabled): it cannot be proven off [C7]');
  else if (seamless.some((v) => v !== false)) f.push('Telegram seamless login must be off: email is the only login method [C7]');
  if (s.merge_accounts_by_email !== false) f.push('merge_accounts_by_email must be off [D3]');
  if (s.allowed_native_app_ids.length > 0) f.push('allowed_native_app_ids must be empty (no native app) [B5]');
  if (s.allowed_native_app_url_schemes.length > 0) f.push('allowed_native_app_url_schemes must be empty [B5]');
  const w = s.embedded_wallet_config;
  if (w.create_on_login !== 'off') f.push(`embedded wallet create_on_login must be off, is ${w.create_on_login} [C5]`);
  if (w.ethereum.create_on_login !== 'off') f.push(`ethereum create_on_login must be off, is ${w.ethereum.create_on_login} [C5]`);
  if (w.solana.create_on_login !== 'off') f.push(`solana create_on_login must be off, is ${w.solana.create_on_login} [D3]`);
  if (expectedMode === null) {
    f.push(`embedded wallet mode is not pinned yet: this app runs ${w.mode}; pin EXPECTED_WALLET_MODE once the live matrix has passed on it [A3] [D1]`);
  } else if (w.mode !== expectedMode) {
    f.push(`embedded wallet mode is ${w.mode}, expected ${expectedMode} (the mode the matrix was proven on) [A3] [D1]`);
  }
  const expected = EXPECTED_DOMAINS[role];
  if (s.allowed_domains.length === 0) f.push('allowed_domains must not be empty');
  if (s.allowed_domains.some((d) => d.includes('*'))) f.push('allowed_domains must not contain a wildcard');
  if (!sameSet(s.allowed_domains, expected)) f.push(`allowed_domains must be exactly [${expected.join(', ')}], is [${s.allowed_domains.join(', ')}]`);
  return {
    ok: f.length === 0,
    failures: f,
    recorded: {
      mode: w.mode,
      user_owned_recovery_options: w.user_owned_recovery_options,
      max_linked_wallets_per_user: s.max_linked_wallets_per_user,
      telegram_seamless_auth_enabled: s.telegram_seamless_auth_enabled ?? 'absent',
      telegram_auth_config_seamless: s.telegram_auth_config?.seamless_auth_enabled ?? 'absent',
    },
  };
}

/// The whole command (scripts/check-privy-config.ts), testable: argv as documented in mako-design RELEASE_RUNBOOK.md
/// step 7 (the role and nothing else), the app id and secret from the shell, and the settings reader. Returns the
/// printed lines and the exit code. `pinnedMode` is EXPECTED_WALLET_MODE in the script; tests pass their own.
export async function runPrivyConfigCheck(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  readSettings: (appId: string, appSecret: string) => Promise<unknown>,
  pinnedMode: string | null,
  now: Date = new Date(),
): Promise<{ exitCode: number; lines: string[] }> {
  const [role, ...extra] = argv;
  if ((role !== 'production' && role !== 'development') || extra.length > 0) {
    return { exitCode: 2, lines: ['usage: check-privy-config.ts production|development (the wallet mode is the reviewed EXPECTED_WALLET_MODE, never an argument)'] };
  }
  const appId = env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
  const appSecret = env.PRIVY_APP_SECRET?.trim();
  if (!appId || !appSecret) return { exitCode: 2, lines: ['NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET must be set in this shell'] };
  const v = checkPrivyAppConfig(await readSettings(appId, appSecret), role, appId, pinnedMode);
  return {
    exitCode: v.ok ? 0 : 1,
    lines: [
      `privy config check, ${role} app ${appId}, ${now.toISOString()}`,
      `recorded: ${JSON.stringify(v.recorded)}`,
      ...v.failures.map((x) => `FAIL ${x}`),
      v.ok ? 'PASS' : `FAIL (${v.failures.length})`,
    ],
  };
}
