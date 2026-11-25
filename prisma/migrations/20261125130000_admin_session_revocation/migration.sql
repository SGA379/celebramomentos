-- JWTs carry the admin auth version. Incrementing it revokes every previously
-- issued admin session without touching customers or business records.
ALTER TABLE "AdminUser" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;
