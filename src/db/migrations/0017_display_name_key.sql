-- Unique display names, case-insensitively (Joshua 2026-10-17). display_name_key is the name in the form two names
-- are compared in (src/lib/display-name.ts displayNameKey: trimmed, inner spaces collapsed, lower case); a partial
-- unique index allows each key once. Backfill: where accounts already share a name, the OLDEST account (created_at,
-- then id) keeps it and the others get no key: they still show their name, but saving it again is refused and they
-- must pick another. A trigger keeps the key equal to the shown name on every insert or name write, whichever app
-- version writes it (the previous app keeps serving after this migration and writes only display_name), so the
-- unique index refuses a duplicate from any writer.
--
-- Verification (after `pnpm db:migrate`):
--   \d users
--   SELECT display_name_key, count(*) FROM users WHERE display_name_key IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   (no rows)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name_key" text;--> statement-breakpoint
UPDATE "users" u SET "display_name_key" = k.key
FROM (
  SELECT "id", lower(regexp_replace(btrim("display_name", ' '), ' +', ' ', 'g')) AS key,
         row_number() OVER (PARTITION BY lower(regexp_replace(btrim("display_name", ' '), ' +', ' ', 'g')) ORDER BY "created_at", "id") AS rn
  FROM "users" WHERE "display_name" IS NOT NULL
) k
WHERE u."id" = k."id" AND k.rn = 1 AND u."display_name_key" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_display_name_key_uniq" ON "users" ("display_name_key") WHERE "display_name_key" IS NOT NULL;;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "users_display_name_key_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."display_name_key" := CASE WHEN NEW."display_name" IS NULL THEN NULL
    ELSE lower(regexp_replace(btrim(NEW."display_name", ' '), ' +', ' ', 'g')) END;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_display_name_key_sync" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_display_name_key_sync" BEFORE INSERT OR UPDATE OF "display_name" ON "users"
FOR EACH ROW EXECUTE FUNCTION "users_display_name_key_sync"();
