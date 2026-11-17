import { NextRequest, NextResponse } from "next/server";
import { podMode, printeersApiVersion } from "@/lib/pod/config";
import { PodApiError } from "@/lib/pod/http";
import { printeersApi } from "@/lib/pod/printeers/api";
import { printeersV2 } from "@/lib/pod/printeers/api-v2";
import { approvedPhoneCase } from "@/lib/pod/printeers/approved";
import { phoneModels, printeersEnvironment, productgroups } from "@/lib/pod/printeers/catalog";
import { podAdapter } from "@/lib/pod/providers";
import { requireAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Printeers setup for admin → Products: the environment in use, what is missing, and the
// product groups to link phone case products to (with Printeers' own prices and whether the
// group is one of the three client-approved case types).
// ?group=… → the phone models customers can pick in that group (read only, from Printeers).
export async function GET(request: NextRequest) {
  const { error } = await requireAdmin(["OWNER", "ADMIN", "EDITOR"]);
  if (error) return error;
  const mode = podMode();
  const environment = printeersEnvironment(mode);
  const group = request.nextUrl.searchParams.get("group");
  if (group !== null) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(group)) return NextResponse.json({ error: "Invalid product group" }, { status: 400 });
    try {
      return NextResponse.json({ environment, models: await phoneModels(group, mode) });
    } catch (reason) {
      return NextResponse.json({ environment, error: reason instanceof PodApiError ? reason.message : "Printeers could not be reached", models: [] }, { status: 503 });
    }
  }
  const problem = podAdapter("PRINTEERS").configurationProblem(mode);
  try {
    const api = printeersApiVersion(mode);
    if (api === "v2") await printeersV2.validate({ mode }); else await printeersApi.validate({ mode });
    const groups = (await productgroups(mode)).map((item) => ({ ...item, approved: approvedPhoneCase(item.name) }));
    return NextResponse.json({ environment, api, problem, connected: true, productgroups: groups });
  } catch (reason) {
    const message = reason instanceof PodApiError ? reason.message : "Printeers could not be reached";
    return NextResponse.json({ environment, problem: problem || message, connected: false, productgroups: [] });
  }
}
