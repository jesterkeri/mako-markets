// Email change for email accounts.
//
// Under Magic this ran Magic's updateEmailWithUI and posted a fresh DID to /api/user/email/update. Since
// 2026-09-29 accounts sign in with Privy (Joshua: everyone moves to Privy), and Privy's own email-change
// flow is not built yet, so a request reports "not supported" and the profile says so plainly instead of
// opening a Magic modal that no longer applies.

export class EmailUpdateNotSupported extends Error {
  constructor() {
    super('Email change is not available yet.');
    this.name = 'EmailUpdateNotSupported';
  }
}

/// Always throws EmailUpdateNotSupported until the Privy email-change flow exists.
export async function requestEmailChange(_args: { newEmail: string }): Promise<{ didToken: string }> {
  void _args;
  throw new EmailUpdateNotSupported();
}
