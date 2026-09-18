import type { NextRequest } from "next/server";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "./request-security";
import { isValidWebSession, isWebPasswordEnabled, OMP_WEB_SESSION_COOKIE } from "./web-auth";

// Also used by streaming uploads, which must not pass through Next's body-cloning proxy.
export function guardApiRequest(request: NextRequest): Response | null {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) {
    return Response.json({ error: "Cross-origin API requests are not allowed" }, { status: 403 });
  }
  if (request.nextUrl.pathname !== "/api/web-auth/session" && isWebPasswordEnabled() && !isValidWebSession(request.cookies.get(OMP_WEB_SESSION_COOKIE)?.value)) {
    return Response.json({ error: "Password required", code: "password_required" }, { status: 401 });
  }
  return null;
}
