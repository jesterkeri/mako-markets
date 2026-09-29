-- Privy identity (Joshua, 2026-09-29: everyone moves from Magic to Privy).
--
-- users.privy_user_id is the Privy user an email account belongs to. NULL means the account has not signed
-- in with Privy yet (a Magic-era account). The first Privy sign-in records it, moving a Magic-era account's
-- signer and Safe to the user's Privy wallet ONCE; after that a different Privy user, even with the same
-- verified email, is refused rather than moving the account again (Codex T2.2 review r1). Unique when set:
-- one Privy user owns at most one account.
--
-- auth_challenges.privy_user_id carries that identity through a 2FA account's pending move, which is applied
-- only after the second factor passes; nothing about the account changes before then.
ALTER TABLE "users" ADD COLUMN "privy_user_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_privy_user_id_uniq" ON "users" ("privy_user_id")
  WHERE "privy_user_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD COLUMN "privy_user_id" text;
