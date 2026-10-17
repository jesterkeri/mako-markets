-- Unique display names, case-insensitively (Joshua 2026-10-17). display_name_key is the name in the form two names
-- are compared in (src/lib/display-name.ts displayNameKey: trimmed, inner spaces collapsed, lower case); a partial
-- unique index allows each key once. Backfill: where accounts already share a name, the OLDEST account (created_at,
-- then id) keeps it and the others get no key: they still show their name, but saving it again is refused and they
-- must pick another. A trigger keeps the key equal to the shown name on every insert or name write, whichever app
-- version writes it (the previous app keeps serving after this migration and writes only display_name); the unique
-- index, and the trigger itself for a name another account still shows without a key, refuse a duplicate from any
-- writer; the account holding the key may always re-save its own name. Known limit: reserved names are checked by the app only, so the previous app could set one during the
-- short overlap.
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
  -- The unique index sees keys only; an account that shared this name before 0017 still shows it with no key, so it
  -- is checked here, with the index's error, so every app version reports it as a taken name. The keeper (already
  -- holding this key) is exempt: it may re-save its own name, or change its case, while duplicates remain.
  IF TG_OP = 'UPDATE' THEN
    IF OLD."display_name_key" IS NOT DISTINCT FROM NEW."display_name_key" THEN RETURN NEW; END IF;
  END IF;
  IF NEW."display_name_key" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "users" o
    WHERE o."id" <> NEW."id" AND o."display_name_key" IS NULL AND o."display_name" IS NOT NULL
      AND lower(regexp_replace(btrim(o."display_name", ' '), ' +', ' ', 'g')) = NEW."display_name_key"
  ) THEN
    RAISE EXCEPTION 'display name % is shown by another account', NEW."display_name"
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'users_display_name_key_uniq';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_display_name_key_sync" ON "users";--> statement-breakpoint
CREATE TRIGGER "users_display_name_key_sync" BEFORE INSERT OR UPDATE OF "display_name" ON "users"
FOR EACH ROW EXECUTE FUNCTION "users_display_name_key_sync"();
