import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Soft gate for workspace subpages: no session cookie → back to the workspace
// landing (login). This is defense-in-depth only — real authorization is
// server-side: every /v1/apps/:id call is owner-scoped, so a non-owner gets 404
// and never sees another developer's data.
// Workspace signs in with session scope "web", so its cookies are
// pid_access_web / pid_refresh_web — not the wallet's unscoped session.
// Accept those (plus any future single-underscore scope), never the
// double-underscore account cookies (pid_refresh__*).
function hasSessionCookie(req: NextRequest): boolean {
  for (const c of req.cookies.getAll()) {
    const n = c.name;
    if (n === "pid_access" || n === "pid_refresh") return true;
    if (n.startsWith("pid_access_")) return true;
    if (n.startsWith("pid_refresh_") && !n.startsWith("pid_refresh__")) return true;
  }
  return false;
}

export function middleware(req: NextRequest) {
  if (hasSessionCookie(req)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/workspace";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/workspace/apps/:path*", "/workspace/chains/:path*", "/workspace/contracts/:path*"],
};
