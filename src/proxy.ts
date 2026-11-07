import { NextResponse, type NextRequest } from "next/server";
import { endedPageHtml, isAppActive } from "@/lib/lifecycle";

/**
 * Runs before every request. Once the prototype's end date has passed (see src/lib/lifecycle.ts),
 * everything is refused with "410 Gone": pages and form submissions get a plain notice page, API
 * calls (uploads, the transcription webhook, local storage) get a JSON 410. Nothing reaches the
 * database, so no student data can be seen or changed. Only /healthz still answers, so the load
 * balancer does not keep restarting the app.
 */
export function proxy(request: NextRequest) {
  if (isAppActive()) return NextResponse.next();

  const path = request.nextUrl.pathname;
  if (path === "/healthz") return NextResponse.next();

  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "This prototype has been deactivated." }, { status: 410 });
  }
  return new NextResponse(endedPageHtml(), {
    status: 410,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export const config = {
  // Everything except Next's own static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
