import { Sandbox } from "@vercel/sandbox";
import { SignJWT, jwtVerify } from "jose";
import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import { previews, versions } from "@eveable/core/schema";
import { readArtifact } from "@eveable/core/artifacts";
import { requireOperation, finishOperation } from "@eveable/core/operations";
import { requireProject } from "@eveable/core/access";
import { AppError, required } from "@eveable/core/errors";
const lifetime = 20 * 60 * 1000;
const secret = () => {
  const value = required("EVEABLE_PREVIEW_SECRET");
  if (value.length < 32)
    throw new Error("Preview signing key must contain at least 32 characters.");
  return new TextEncoder().encode(value);
};
export function previewOrigin(id: string) {
  const base = new URL(required("PREVIEW_ORIGIN"));
  const builder = new URL(required("APP_ORIGIN"));
  if (
    base.origin === builder.origin ||
    !["http:", "https:"].includes(base.protocol)
  )
    throw new Error("Preview origin must be isolated from the builder.");
  base.hostname = `${id}.${base.hostname}`;
  return base.origin;
}
export async function startPreview(operationId: string) {
  const { op } = await requireOperation(operationId);
  if (op.kind !== "preview" || !op.versionId)
    throw new Error("Preview operation required.");
  let preview = await database().query.previews.findFirst({
    where: eq(previews.operationId, op.id),
  });
  if (preview?.status === "ready") return;
  if (!preview)
    [preview] = await database()
      .insert(previews)
      .values({
        projectId: op.projectId,
        versionId: op.versionId,
        operationId: op.id,
      })
      .returning();
  const version = await database().query.versions.findFirst({
    where: and(
      eq(versions.id, op.versionId),
      eq(versions.projectId, op.projectId),
    ),
  });
  if (!version) throw new Error("Version not found.");
  const name = `eveable-preview-${preview.id}`;
  let sandbox: Sandbox | undefined;
  try {
    const files = await readArtifact(version);
    sandbox = await Sandbox.getOrCreate({
      name,
      ports: [],
      runtime: "node24",
      persistent: false,
      timeout: lifetime,
      env: { NEXT_TELEMETRY_DISABLED: "1", CI: "true" },
    });
    await database()
      .update(previews)
      .set({ sandboxName: name, status: "starting" })
      .where(eq(previews.id, preview.id));
    await sandbox.runCommand("mkdir", ["-p", "/vercel/sandbox/app"]);
    await sandbox.writeFiles(
      files.map((file) => ({
        path: `/vercel/sandbox/app/${file.path}`,
        content: Buffer.from(file.content),
      })),
    );
    for (const args of [
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      ["run", "build"],
    ]) {
      const result = await sandbox.runCommand({
        cmd: "npm",
        args,
        cwd: "/vercel/sandbox/app",
        timeoutMs: 180000,
      });
      if (result.exitCode !== 0) throw new Error("Preview build failed.");
    }
    // No ports are exposed. Every browser request uses the authenticated SDK bridge.
    await sandbox.runCommand({
      cmd: "node",
      args: [
        "node_modules/next/dist/bin/next",
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        "4173",
      ],
      cwd: "/vercel/sandbox/app",
      detached: true,
    });
    const health = await sandbox.runCommand({
      cmd: "node",
      args: [
        "-e",
        `(async()=>{for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:4173');if(r.ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)})()`,
      ],
      timeoutMs: 35000,
    });
    if (health.exitCode !== 0) throw new Error("Preview health check failed.");
    await requireOperation(op.id);
    if (preview.createdAt.getTime() + lifetime - 60000 <= Date.now())
      throw new Error("Preview expired while starting.");
    await database()
      .update(previews)
      .set({
        status: "ready",
        expiresAt: new Date(preview.createdAt.getTime() + lifetime - 60000),
      })
      .where(eq(previews.id, preview.id));
    await finishOperation(op.id, "completed", "preview_available");
  } catch (error) {
    await sandbox?.stop().catch(() => undefined);
    await database()
      .update(previews)
      .set({ status: "failed" })
      .where(eq(previews.id, preview.id));
    throw error;
  }
}
export async function previewGrant(userId: string, id: string, access = false) {
  const p = await database().query.previews.findFirst({
    where: eq(previews.id, id),
  });
  if (!p) throw new AppError(404, "not_found", "Preview not found.");
  await requireProject(userId, p.projectId);
  if (
    p.status !== "ready" ||
    !p.expiresAt ||
    p.expiresAt.getTime() < Date.now()
  )
    throw new AppError(410, "preview_expired", "Start the preview again.");
  return new SignJWT({
    userId,
    projectId: p.projectId,
    previewId: p.id,
    access,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("eveable-preview")
    .setAudience(previewOrigin(id))
    .setIssuedAt()
    .setExpirationTime(
      access
        ? Math.min(
            Math.floor(p.expiresAt.getTime() / 1000),
            Math.floor(Date.now() / 1000) + 900,
          )
        : "60s",
    )
    .sign(secret());
}
export async function verifyPreviewGrant(
  token: string,
  id: string,
  access: boolean,
) {
  const { payload } = await jwtVerify(token, secret(), {
    algorithms: ["HS256"],
    issuer: "eveable-preview",
    audience: previewOrigin(id),
  });
  if (
    payload.previewId !== id ||
    payload.access !== access ||
    typeof payload.userId !== "string" ||
    typeof payload.projectId !== "string"
  )
    throw new AppError(403, "invalid_access", "Preview access denied.");
  await requireProject(payload.userId, payload.projectId);
  const p = await database().query.previews.findFirst({
    where: and(eq(previews.id, id), eq(previews.projectId, payload.projectId)),
  });
  if (
    !p ||
    p.status !== "ready" ||
    !p.sandboxName ||
    !p.expiresAt ||
    p.expiresAt.getTime() < Date.now()
  )
    throw new AppError(
      410,
      "preview_expired",
      "This preview expired. Start it again from Eveable.",
    );
  return { preview: p, userId: payload.userId };
}
export function safePreviewPath(path: string) {
  return (
    path.startsWith("/") && !path.startsWith("//") && !/[\\\r\n\x00]/.test(path)
  );
}
// Constant program, request data passed as an argument, never interpolated shell code.
const bridgeProgram = `(async()=>{const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString());const r=await fetch('http://127.0.0.1:4173'+p.path,{method:p.method,headers:p.headers,body:p.body?Buffer.from(p.body,'base64'):undefined,redirect:'manual',signal:AbortSignal.timeout(15000)});const chunks=[];let size=0;for await(const c of r.body??[]){size+=c.length;if(size>8000000)throw Error('Response too large');chunks.push(c)}console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:Buffer.concat(chunks).toString('base64')}))})().catch(()=>process.exit(1))`;
export async function bridgePreview(
  sandboxName: string,
  request: Request,
  path: string,
) {
  if (
    !safePreviewPath(path) ||
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
      request.method,
    )
  )
    throw new AppError(
      400,
      "invalid_preview_request",
      "Invalid preview request.",
    );
  const body = ["GET", "HEAD"].includes(request.method)
    ? undefined
    : Buffer.from(await request.arrayBuffer());
  if (body && body.length > 1_000_000)
    throw new AppError(413, "too_large", "Preview request too large.");
  const headers: Record<string, string> = {};
  for (const name of [
    "accept",
    "content-type",
    "range",
    "next-action",
    "rsc",
    "next-router-state-tree",
    "next-url",
  ]) {
    const v = request.headers.get(name);
    if (v) headers[name] = v;
  }
  const sb = await Sandbox.get({ name: sandboxName });
  if (sb.status !== "running")
    throw new AppError(
      410,
      "preview_expired",
      "Preview stopped. Start it again.",
    );
  const result = await sb.runCommand({
    cmd: "node",
    args: [
      "-e",
      bridgeProgram,
      Buffer.from(
        JSON.stringify({
          path,
          method: request.method,
          headers,
          body: body?.toString("base64"),
        }),
      ).toString("base64"),
    ],
    timeoutMs: 20000,
  });
  if (result.exitCode !== 0)
    throw new AppError(502, "preview_unavailable", "Preview did not respond.");
  const data = JSON.parse(await result.stdout()) as {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  const output = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `frame-ancestors ${new URL(required("APP_ORIGIN")).origin}; object-src 'none'; base-uri 'self'`,
  });
  for (const name of ["content-type", "content-range", "accept-ranges", "vary"])
    if (data.headers[name]) output.set(name, data.headers[name]);
  if (data.headers.location) {
    const target = new URL(data.headers.location, "http://127.0.0.1:4173");
    if (target.origin !== "http://127.0.0.1:4173")
      throw new AppError(
        400,
        "external_redirect",
        "External redirects are unavailable inside previews.",
      );
    output.set("location", target.pathname + target.search);
  }
  return new Response(
    request.method === "HEAD" || [204, 304].includes(data.status)
      ? null
      : Buffer.from(data.body, "base64"),
    { status: data.status, headers: output },
  );
}
