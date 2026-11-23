import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const admin = await getAdminSession();
  const response = admin ? NextResponse.json({ admin }) : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}
