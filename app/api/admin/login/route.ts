import { NextRequest, NextResponse } from "next/server";
import { createAdminSession, setAdminCookie, verifyPassword } from "@/lib/server/auth";
import { prisma } from "@/lib/server/prisma";
import { adminLoginSchema } from "@/lib/server/validation";
import { handleApiError, jsonError } from "@/lib/server/http";

export async function POST(request: NextRequest) {
  try {
    const input = adminLoginSchema.parse(await request.json());
    const admin = await prisma.adminUser.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!admin || !admin.active || !(await verifyPassword(input.password, admin.passwordHash))) return jsonError("Invalid credentials", 401);
    const response = NextResponse.json({ admin: { id: admin.id, email: admin.email, name: admin.name } });
    setAdminCookie(response, await createAdminSession(admin.id));
    return response;
  } catch (error) {
    const response = handleApiError(error);
    return response;
  }
}
