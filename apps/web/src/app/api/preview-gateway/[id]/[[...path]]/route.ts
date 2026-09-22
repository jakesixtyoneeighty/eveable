import { z } from "zod";
import {
  previewOrigin,
  previewGrant,
  verifyPreviewGrant,
  bridgePreview,
} from "@eveable/core/preview";
import { required } from "@eveable/core/errors";
export const runtime = "nodejs";
export const maxDuration = 30;
async function gateway(
  request: Request,
  context: { params: Promise<{ id: string; path?: string[] }> },
) {
  try {
    const { id, path = [] } = await context.params;
    z.uuid().parse(id);
    const origin = previewOrigin(id);
    if (request.headers.get("host") !== new URL(origin).host)
      return new Response("Not found", { status: 404 });
    if (path.join("/") === "__eveable_access" && request.method === "POST") {
      if (
        request.headers.get("origin") !== new URL(required("APP_ORIGIN")).origin
      )
        return new Response("Access denied", { status: 403 });
      const data = await request.formData();
      const { userId } = await verifyPreviewGrant(
        String(data.get("token") ?? ""),
        id,
        false,
      );
      const token = await previewGrant(userId, id, true);
      const secure = new URL(origin).protocol === "https:";
      return new Response(null, {
        status: 303,
        headers: {
          location: `${origin}/`,
          "set-cookie": `eveable_preview=${token}; HttpOnly; Path=/; Max-Age=900; ${secure ? "Secure; SameSite=None; Partitioned" : "SameSite=Lax"}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    const token =
      request.headers
        .get("cookie")
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("eveable_preview="))
        ?.slice("eveable_preview=".length) ?? "";
    const { preview } = await verifyPreviewGrant(token, id, true);
    const search = new URL(request.url).search;
    return await bridgePreview(
      preview.sandboxName!,
      request,
      "/" + path.map(encodeURIComponent).join("/") + search,
    );
  } catch {
    return new Response(
      "Preview unavailable or access expired. Open the preview again from Eveable.",
      {
        status: 403,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}
export const GET = gateway;
export const POST = gateway;
export const PUT = gateway;
export const PATCH = gateway;
export const DELETE = gateway;
export const HEAD = gateway;
