import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Soft gate for workspace subpages: no session cookie → back to the workspace
// landing (login). This is defense-in-depth only — real authorization is
// server-side: every /v1/apps/:id call is owner-scoped, so a non-owner gets 404
// and never sees another developer's data.
const SESSION_COOKIES = ["pid_access", "pid_refresh"];

export function middleware(req: NextRequest) {
  const hasSession = SESSION_COOKIES.some((c) => req.cookies.get(c));
  if (hasSession) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/workspace";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/workspace/apps/:path*", "/workspace/chains/:path*", "/workspace/contracts/:path*"],
};
