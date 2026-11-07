import type { NextRequest } from "next/server";
import { cognitoConfig, finishLogin, getVerifier } from "@/lib/auth/cognito";
import { authMode } from "@/lib/auth/dev";

export const dynamic = "force-dynamic";

// Cognito sends the browser back here with a one-time code. We swap it for tokens, check them, and start the session.
export async function GET(request: NextRequest) {
  if (authMode() !== "cognito") return new Response("Not found", { status: 404 });
  const cfg = cognitoConfig();
  return finishLogin(request, cfg, { verify: getVerifier(cfg) });
}
