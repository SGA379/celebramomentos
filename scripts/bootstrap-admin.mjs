import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const confirmation = process.env.ADMIN_BOOTSTRAP_CONFIRM;
const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
const name = process.env.ADMIN_BOOTSTRAP_NAME?.trim() || "Owner";

if (confirmation !== "RESET_ADMIN") throw new Error("Set ADMIN_BOOTSTRAP_CONFIRM=RESET_ADMIN to run the admin bootstrap.");
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Set a valid ADMIN_BOOTSTRAP_EMAIL.");

const prisma = new PrismaClient();
const temporaryPassword = crypto.randomBytes(24).toString("base64url");

try {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.adminUser.findUnique({ where: { email }, select: { id: true } });

    // Revoke every previous admin session and credential without deleting rows
    // or touching customer, order, payment, product, or audit data.
    await tx.adminUser.updateMany({
      where: existing ? { id: { not: existing.id } } : {},
      data: { active: false, authVersion: { increment: 1 } },
    });

    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const admin = existing
      ? await tx.adminUser.update({ where: { id: existing.id }, data: { email, name, passwordHash, active: true, authVersion: { increment: 1 }, mustChangePassword: true }, select: { id: true, email: true } })
      : await tx.adminUser.create({ data: { email, name, passwordHash, active: true, authVersion: 1, mustChangePassword: true }, select: { id: true, email: true } });

    await tx.auditLog.create({ data: { adminUserId: admin.id, action: "BOOTSTRAP_CREDENTIALS", entity: "AdminUser", entityId: admin.id, metadata: { email: admin.email } } });
    return admin;
  });

  // This is the only place the temporary password is emitted. Do not redirect
  // this command's output to application logs or commit it to source control.
  console.log(JSON.stringify({ email: result.email, password: temporaryPassword, adminId: result.id, requiresPasswordChange: true }, null, 2));
} finally {
  await prisma.$disconnect();
}
