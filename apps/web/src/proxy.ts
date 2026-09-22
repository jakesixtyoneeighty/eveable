import { clerkMiddleware } from "@clerk/nextjs/server";
import {
  NextResponse,
  type NextRequest,
  type NextFetchEvent,
} from "next/server";
const clerk = clerkMiddleware();
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const base = process.env.PREVIEW_ORIGIN;
  if (base) {
    const suffix = "." + new URL(base).host;
    const host = request.headers.get("host") ?? "";
    if (host.endsWith(suffix)) {
      const id = host.slice(0, -suffix.length);
      if (!/^[a-f0-9-]{36}$/.test(id))
        return new NextResponse("Not found", { status: 404 });
      const url = request.nextUrl.clone();
      url.pathname = `/api/preview-gateway/${id}${request.nextUrl.pathname}`;
      return NextResponse.rewrite(url);
    }
  }
  if (request.nextUrl.pathname.startsWith("/api/preview-gateway/"))
    return new NextResponse("Not found", { status: 404 });
  if (
    request.nextUrl.pathname.startsWith("/_next/") ||
    request.nextUrl.pathname === "/favicon.ico"
  )
    return NextResponse.next();
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
    return NextResponse.next();
  return clerk(request, event);
}
// Include generated Next assets: preview routing must run before builder asset exclusions.
export const config = { matcher: ["/:path*"] };
