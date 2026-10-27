// How long a Mako-TOTP lockout lasts once the fifth wrong code lands. Its own module (SIGNIN_REMEMBERED_BROWSER_PLAN r29,
// [r27]) so the real-PostgreSQL timing test can shorten it through vi.mock while bumpTotpFailedAttempts keeps its
// signature with no length argument: no production caller can pass, or reach, a shorter lockout.
export const LOCKOUT_SECONDS = 15 * 60;
