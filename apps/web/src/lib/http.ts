import { AppError } from "@eveable/core/errors";
import { ZodError } from "zod";
export async function handled(fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    if (error instanceof ZodError)
      return Response.json(
        { error: "Invalid request.", code: "invalid_request" },
        { status: 400 },
      );
    console.error(
      "Request failed",
      error instanceof Error ? error.name : "unknown",
    );
    return Response.json(
      {
        error:
          "This operation is temporarily unavailable. Check service configuration or try again.",
        code: "service_unavailable",
      },
      { status: 503 },
    );
  }
}
export async function body(request: Request, limit = 24000) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new AppError(413, "too_large", "Request is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "invalid_json", "Invalid JSON request.");
  }
}
