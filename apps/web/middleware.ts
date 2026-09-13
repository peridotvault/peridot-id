import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Workspace gate (UX fast-path, not the security boundary).
 * Anything under /workspace except the login page itself requires a session
 * cookie — otherwise bounce to /workspace (login). Real enforcement stays
 * server-side (JwtAuthGuard/AdminGuard) plus the page-level guards.
 */
export function middleware(req: NextRequest) {
  if (!req.cookies.get("pid_access")) {
    return NextResponse.redirect(new URL("/workspace", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/workspace/chains/:path*", "/workspace/contracts/:path*"],
};
