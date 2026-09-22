import type { SandboxSession } from "eve/sandbox";
import { requireOperation } from "@eveable/core/operations";
import {
  canonicalSource,
  safePath,
  type SourceFile,
} from "@eveable/core/artifacts";
import { buildSandboxFilePath } from "./sandbox.js";
const manifestPath = "/workspace/generated-app/.eveable-manifest.json";
export async function projectOperation(
  ctx: {
    session: {
      id: string;
      auth: {
        current: {
          authenticator: string;
          principalId: string;
          attributes?: Readonly<Record<string, unknown>>;
        } | null;
      };
    };
  },
  mutation = false,
) {
  const auth = ctx.session.auth.current;
  if (auth?.authenticator !== "eveable") {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.EVEABLE_ALLOW_LOCAL_TUI === "true"
    )
      return null;
    throw new Error("Authenticated project operation required.");
  }
  const id = auth.attributes?.operationId;
  if (typeof id !== "string") throw new Error("Missing operation identity.");
  const result = await requireOperation(id);
  if (
    result.op.sessionId !== ctx.session.id ||
    result.op.ownerId !== auth.principalId
  )
    throw new Error("Operation session mismatch.");
  if (mutation && !result.op.approved)
    throw new Error("Explicit approval is required before changing files.");
  return result;
}
export async function readManifest(sandbox: SandboxSession): Promise<string[]> {
  try {
    const paths: unknown = JSON.parse(
      (await sandbox.readTextFile({ path: manifestPath })) ?? "null",
    );
    if (
      Array.isArray(paths) &&
      paths.every((p) => typeof p === "string" && safePath(p))
    )
      return paths;
  } catch {
    /* A new workspace has no manifest yet. */
  }
  return [];
}
export async function recordManifest(sandbox: SandboxSession, paths: string[]) {
  if (!paths.every(safePath)) throw new Error("Unsafe generated file path.");
  await sandbox.writeTextFile({
    path: manifestPath,
    content: JSON.stringify([...new Set(paths)].sort()),
  });
}
export async function actualSource(
  sandbox: SandboxSession,
): Promise<SourceFile[]> {
  const paths = await readManifest(sandbox);
  if (!paths.length) throw new Error("No generated source manifest.");
  // Generated code can create symlinks during installation/build. Recheck real
  // paths before reading an archive, not only the spelling of manifest entries.
  const check =
    "const f=require('node:fs'),p=require('node:path');const base=f.realpathSync('/workspace/generated-app');for(const name of JSON.parse(Buffer.from(process.argv[2],'base64').toString())){const path=p.join(base,name);if(f.lstatSync(path).isSymbolicLink()||!f.realpathSync(path).startsWith(base+'/'))process.exit(1)}";
  const checkResult = await sandbox.run({
    command: `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" '${Buffer.from(check).toString("base64")}' '${Buffer.from(JSON.stringify(paths)).toString("base64")}'`,
  });
  if (checkResult.exitCode !== 0)
    throw new Error("Source contains a symlink or escaped workspace path.");
  const files = [];
  for (const path of paths) {
    const content = await sandbox.readTextFile({
      path: buildSandboxFilePath(path),
    });
    if (content === null) throw new Error(`Missing generated source: ${path}`);
    files.push({ path, content });
  }
  return canonicalSource(files).files;
}
