-- Ref tags (2026-10-01): which X post brought an account, for the beta campaign. The site keeps the tag from a
-- post's link (`?utm_campaign=` or `?ref=`) in a cookie, and the sign-in routes copy it here when they CREATE the
-- account; an existing account's tag never changes. NULL means no tag. The CHECK is the same rule as
-- src/lib/ref-tag.ts, which every writer applies first, so a bad tag is dropped rather than failing a sign-in.
ALTER TABLE "users" ADD COLUMN "ref" text;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_ref_format_chk" CHECK ("ref" IS NULL OR "ref" ~ '^[a-z0-9-]{1,32}$');
