import { createHash } from "node:crypto";
import { put, get } from "@vercel/blob";
import { z } from "zod";
import { AppError } from "@eveable/core/errors";
export const sourceSchema = z
  .array(
    z.object({
      path: z.string().min(1).max(240),
      content: z.string().max(2_000_000),
    }),
  )
  .min(1)
  .max(500);
export type SourceFile = z.infer<typeof sourceSchema>[number];
export function safePath(path: string) {
  return (
    !path.startsWith("/") &&
    !/[\\\x00-\x1f]/.test(path) &&
    !path
      .split("/")
      .some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          /^(\.env(?:\..*)?|node_modules|\.next|\.git|\.vercel|\.eveable.*|dist|\.output)$/i.test(
            s,
          ),
      ) &&
    /^[\w./@()[\] -]+$/.test(path)
  );
}
export function canonicalSource(input: unknown) {
  const files = sourceSchema
    .parse(input)
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const seen = new Set<string>();
  for (const file of files) {
    if (!safePath(file.path) || seen.has(file.path))
      throw new AppError(
        400,
        "unsafe_source",
        "Source archive contains an unsafe or duplicate path.",
      );
    seen.add(file.path);
    if (
      /-----BEGIN .*PRIVATE KEY-----|\b(?:sk_live_|sk-proj-|ghp_)[A-Za-z0-9_-]{16,}/.test(
        file.content,
      )
    )
      throw new AppError(
        400,
        "secret_detected",
        "Source contains credential material.",
      );
    for (const [name, value] of Object.entries(process.env))
      if (
        /(SECRET|TOKEN|API_KEY|DATABASE_URL)/.test(name) &&
        value &&
        value.length >= 12 &&
        file.content.includes(value)
      )
        throw new AppError(
          400,
          "secret_detected",
          "Source contains a runtime secret.",
        );
  }
  const body = JSON.stringify(files);
  if (Buffer.byteLength(body) > 10_000_000)
    throw new AppError(
      413,
      "archive_too_large",
      "Generated source exceeds the 10 MB archive limit.",
    );
  return { files, body, hash: createHash("sha256").update(body).digest("hex") };
}
export async function saveArtifact(
  projectId: string,
  operationId: string,
  input: unknown,
) {
  const source = canonicalSource(input);
  const blob = await put(
    `projects/${projectId}/${operationId}/${source.hash}.json`,
    source.body,
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    },
  );
  return {
    hash: source.hash,
    blobPath: blob.pathname,
    manifest: source.files.map((f) => f.path),
  };
}
export async function readArtifact(version: {
  blobPath: string;
  hash: string;
}) {
  const result = await get(version.blobPath, {
    access: "private",
    useCache: false,
  });
  if (!result || result.statusCode !== 200)
    throw new AppError(
      503,
      "artifact_unavailable",
      "Saved source is temporarily unavailable.",
    );
  const body = await new Response(result.stream).text();
  const source = canonicalSource(JSON.parse(body));
  if (source.hash !== version.hash)
    throw new AppError(
      409,
      "artifact_mismatch",
      "Saved source failed its integrity check.",
    );
  return source.files;
}
