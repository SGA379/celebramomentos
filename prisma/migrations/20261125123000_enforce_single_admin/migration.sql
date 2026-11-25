-- Admin authentication is intentionally single-account. Preserve existing rows
-- and IDs, but disable any newer active duplicates before enforcing the rule.
WITH ranked_active_admins AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, id ASC) AS row_number
  FROM "AdminUser"
  WHERE active = true
)
UPDATE "AdminUser"
SET active = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM ranked_active_admins WHERE row_number > 1);

CREATE UNIQUE INDEX "AdminUser_one_active_key"
ON "AdminUser" (active)
WHERE active = true;
