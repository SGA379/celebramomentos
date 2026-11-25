import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { clearAdminCookie, hashPassword, requireAdmin, verifyPassword } from "@/lib/server/auth";
import { handleApiError, jsonError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { adminPasswordChangeSchema, adminProfileUpdateSchema } from "@/lib/server/validation";

export const dynamic = "force-dynamic";

const adminSelect = { id: true, email: true, name: true, createdAt: true, updatedAt: true } as const;

export async function GET() {
  const { error, admin } = await requireAdmin();
  if (error) return error;
  const response = NextResponse.json({ admin });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export async function PATCH(request: NextRequest) {
  const { error, admin } = await requireAdmin();
  if (error) return error;
  try {
    const body = await request.json() as Record<string, unknown>;

    if (body.action === "update-profile") {
      const input = adminProfileUpdateSchema.parse(body);
      const email = input.email.trim().toLowerCase();
      const current = await prisma.adminUser.findUnique({ where: { id: admin!.id }, select: { passwordHash: true, active: true } });
      if (!current?.active || !(await verifyPassword(input.currentPassword, current.passwordHash))) return jsonError("Current password is incorrect.", 400);
      const emailOwner = await prisma.adminUser.findFirst({ where: { email, NOT: { id: admin!.id } }, select: { id: true } });
      if (emailOwner) return jsonError("This email address is already assigned to another admin account.", 409);
      const updated = await prisma.$transaction(async (tx) => {
        const account = await tx.adminUser.update({ where: { id: admin!.id }, data: { name: input.name, email }, select: adminSelect });
        await tx.auditLog.create({ data: { adminUserId: admin!.id, action: "UPDATE_PROFILE", entity: "AdminUser", entityId: admin!.id, metadata: { email: account.email } } });
        return account;
      });
      return NextResponse.json({ admin: updated });
    }

    const input = adminPasswordChangeSchema.parse(body);
    const current = await prisma.adminUser.findUnique({ where: { id: admin!.id }, select: { passwordHash: true, active: true } });
    if (!current?.active || !(await verifyPassword(input.currentPassword, current.passwordHash))) return jsonError("Current password is incorrect.", 400);
    await prisma.$transaction([
      prisma.adminUser.update({ where: { id: admin!.id }, data: { passwordHash: await hashPassword(input.newPassword), authVersion: { increment: 1 }, mustChangePassword: false } }),
      prisma.auditLog.create({ data: { adminUserId: admin!.id, action: "CHANGE_PASSWORD", entity: "AdminUser", entityId: admin!.id } }),
    ]);
    const response = NextResponse.json({ ok: true, requiresLogin: true });
    clearAdminCookie(response);
    return response;
  } catch (reason) {
    if (reason instanceof Prisma.PrismaClientKnownRequestError && reason.code === "P2002") {
      return jsonError("This email address is already assigned to another admin account.", 409);
    }
    if (reason instanceof Prisma.PrismaClientKnownRequestError && (reason.code === "P2021" || reason.code === "P2022")) {
      return jsonError("Account settings are unavailable until the database migrations are deployed.", 503);
    }
    return handleApiError(reason);
  }
}
