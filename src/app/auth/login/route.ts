import { cognitoConfig, startLogin } from "@/lib/auth/cognito";
import { authMode } from "@/lib/auth/dev";

export const dynamic = "force-dynamic";

// Sends the browser to Cognito's hosted sign-in page (authorization code flow with PKCE).
export function GET() {
  if (authMode() !== "cognito") return new Response("Not found", { status: 404 });
  return startLogin(cognitoConfig());
}
