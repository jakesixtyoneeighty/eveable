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
export async function body(request: Request) {
  const text = await request.text();
  if (Buffer.byteLength(text) > 24000)
    throw new AppError(413, "too_large", "Request is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "invalid_json", "Invalid JSON request.");
  }
}
