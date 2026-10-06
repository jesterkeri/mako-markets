// Adversary (INBOX_GAP_PLAN r18 [M5], [C7]): "google_oauth and every other OAuth provider ... are off", so an email
// account's Privy user can only be signed into with its email code. The installed @privy-io/node 0.35.0 AppResponse
// (resources/apps/apps.d.ts:103) carries custom OAuth providers as an array, `custom_oauth_providers`, not as a boolean
// flag, so a check that only walks boolean names never sees one that is enabled.
import type { AppResponse } from '@privy-io/node';
import { describe, expect, it } from 'vitest';

import { checkPrivyAppConfig, OTHER_LOGIN_METHODS, type PrivyAppSettings } from '@/lib/privy-config-check';

const PROD = 'cm-prod-app-id-0000000000';

// Typed against the SDK's own AppResponse fields, so the name and shape are the ones Privy returns.
const customOAuth: Pick<AppResponse, 'custom_oauth_providers'> = {
  custom_oauth_providers: [{ enabled: true, provider: 'custom:attacker-idp', provider_display_name: 'Attacker IdP', provider_icon_url: 'https://example.invalid/icon.png' }],
};

const settings: PrivyAppSettings = {
  id: PROD,
  allowed_domains: ['https://makomarket.xyz'],
  allowed_native_app_ids: [],
  allowed_native_app_url_schemes: [],
  mfa_methods: ['totp'],
  passkey_auth: false,
  passkeys_for_signup_enabled: false,
  email_auth: true,
  merge_accounts_by_email: false,
  embedded_wallet_config: { create_on_login: 'off', ethereum: { create_on_login: 'off' }, solana: { create_on_login: 'off' }, mode: 'user-controlled-server-wallets-only', user_owned_recovery_options: [] },
  ...Object.fromEntries(OTHER_LOGIN_METHODS.map((m) => [m, false])),
  ...customOAuth,
};

describe('checkPrivyAppConfig, adversary: a custom OAuth provider is another way in [C7]', () => {
  it('fails when a custom OAuth login provider is enabled', () => {
    const v = checkPrivyAppConfig(settings, 'production', PROD, 'user-controlled-server-wallets-only');
    expect(v.ok).toBe(false);
  });
});
