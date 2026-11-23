-- Roles are no longer part of admin authentication. Existing admin rows and
-- password hashes are preserved; only the unused role metadata is removed.
ALTER TABLE "AdminUser" DROP COLUMN IF EXISTS "role";
DROP TYPE IF EXISTS "AdminRole";
