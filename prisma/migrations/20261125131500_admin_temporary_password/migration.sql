-- Bootstrap credentials are temporary and must be replaced from Account Settings.
ALTER TABLE "AdminUser" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
