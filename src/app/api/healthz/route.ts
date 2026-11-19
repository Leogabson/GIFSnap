import { NextResponse } from "next/server";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      time: new Date().toISOString(),
      commit: config.VERCEL_GIT_COMMIT_SHA || "local",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
