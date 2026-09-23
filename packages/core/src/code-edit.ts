import { Sandbox } from "@vercel/sandbox";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { database } from "@eveable/core/db";
import {
  activity,
  members,
  operations,
  previews,
  projects,
  versions,
} from "@eveable/core/schema";
import { readArtifact } from "@eveable/core/artifacts";
import { requireOperation, finishOperation } from "@eveable/core/operations";
import { reviewSource } from "@eveable/core/source-review";
import { AppError } from "@eveable/core/errors";

const workspace = "/vercel/sandbox/app";
const lifetime = 20 * 60 * 1000;
const draftSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  blobPath: z.string().min(1),
  manifest: z.array(z.string()),
});
export type CodeEditPhase =
  "prepare" | "install" | "typecheck" | "build" | "verify";
const messages: Record<CodeEditPhase, string> = {
  prepare: "Preparing code changes",
  install: "Installing dependencies",
  typecheck: "Checking TypeScript",
  build: "Building your changes",
  verify: "Checking preview and source",
};
const sandboxName = (id: string) => `eveable-code-${id}`;

// The trusted program reads the exact manifest back, rejects symlinks (including
// ancestor directories), and returns only its hash. Paths are argv, never shell.
export const sourceHashProgram = `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const base='${workspace}',files=[];let size=0;
for(const name of process.argv.slice(1)){
 const full=p.join(base,name),stat=fs.lstatSync(full);
 if(!stat.isFile()||fs.realpathSync(full)!==full||stat.size>8000000)process.exit(1);
 size+=stat.size;if(size>10000000)process.exit(1);
 files.push({path:name,content:fs.readFileSync(full,'utf8')});
}
process.stdout.write(c.createHash('sha256').update(JSON.stringify(files)).digest('hex'));`;

async function editOperation(id: string) {
  const current = await requireOperation(id);
  if (
    current.op.kind !== "code_edit" ||
    !current.op.approved ||
    current.op.baseVersionId !== current.project.currentVersionId
  )
    throw new AppError(
      409,
      "version_changed",
      "The saved version changed. Your draft has not been applied.",
    );
  if (Date.now() - current.op.createdAt.getTime() > lifetime - 60000)
    throw new AppError(
      410,
      "edit_expired",
      "Code validation expired. Your draft has not been applied.",
    );
  return { ...current, draft: draftSchema.parse(current.op.payload.draft) };
}

export async function runCodeEditPhase(id: string, phase: CodeEditPhase) {
  // A replay after the atomic commit must not restart a sandbox or create a version.
  const done = await database().query.operations.findFirst({
    where: eq(operations.id, id),
  });
  if (done?.kind === "code_edit" && done.status === "completed") return;
  const { op, draft } = await editOperation(id);
  await database()
    .insert(activity)
    .values({
      projectId: op.projectId,
      eventKey: `code:${id}:${phase}`,
      kind: "stage",
      data: { label: messages[phase] },
    })
    .onConflictDoNothing();
  const files = await readArtifact(draft);
  const sandbox =
    phase === "prepare"
      ? await Sandbox.getOrCreate({
          name: sandboxName(id),
          ports: [],
          runtime: "node24",
          persistent: false,
          timeout: lifetime,
          env: { NEXT_TELEMETRY_DISABLED: "1", CI: "true" },
        })
      : await Sandbox.get({ name: sandboxName(id) });
  if (sandbox.status !== "running")
    throw new Error("Code sandbox unavailable.");
  if (phase === "prepare") {
    await sandbox.runCommand({
      cmd: "mkdir",
      args: ["-p", workspace],
      timeoutMs: 10000,
    });
    await sandbox.writeFiles(
      files.map((f) => ({
        path: `${workspace}/${f.path}`,
        content: Buffer.from(f.content),
      })),
    );
    return;
  }
  if (phase !== "verify") {
    // Run the actual tools rather than editable package scripts that could skip checks.
    const command =
      phase === "install"
        ? {
            cmd: "npm",
            args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
          }
        : {
            cmd: "node",
            args:
              phase === "typecheck"
                ? ["node_modules/typescript/bin/tsc", "--noEmit"]
                : ["node_modules/next/dist/bin/next", "build"],
          };
    const result = await sandbox.runCommand({
      ...command,
      cwd: workspace,
      timeoutMs: 180000,
    });
    if (result.exitCode !== 0)
      throw new AppError(
        422,
        "code_validation_failed",
        `${messages[phase]} failed. Review your code and try Save & Preview again.`,
      );
    return;
  }
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
    cwd: workspace,
    detached: true,
  });
  const health = await sandbox.runCommand({
    cmd: "node",
    args: [
      "-e",
      `(async()=>{for(let i=0;i<20;i++){try{const r=await fetch('http://127.0.0.1:4173',{signal:AbortSignal.timeout(1000)});if(r.ok)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,500))}process.exit(1)})()`,
    ],
    timeoutMs: 35000,
  });
  if (health.exitCode !== 0)
    throw new AppError(
      422,
      "preview_failed",
      "Your edited app did not pass its preview health check. Your draft is still available.",
    );
  const readback = await sandbox.runCommand({
    cmd: "node",
    args: ["-e", sourceHashProgram, "--", ...files.map((f) => f.path)],
    timeoutMs: 20000,
  });
  if (
    readback.exitCode !== 0 ||
    (await readback.stdout()).trim() !== draft.hash
  )
    throw new AppError(
      422,
      "source_changed",
      "Source changed during validation or contains a symlink. Your draft has not been saved.",
    );
  const review = reviewSource(files);
  if (review.status !== "passed")
    throw new AppError(
      422,
      "source_review_failed",
      `Source review: ${review.findings
        .slice(0, 3)
        .map((f) => `${f.file ?? "Source"}: ${f.issue}`)
        .join(" ")}`,
    );
  await editOperation(id);
  const expiresAt = new Date(op.createdAt.getTime() + lifetime - 60000);
  await database().transaction(async (tx) => {
    // Serialize with admission and membership revocation at the final commit.
    const member = await tx
      .select()
      .from(members)
      .where(and(eq(members.userId, op.ownerId), eq(members.active, true)))
      .for("share");
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, op.projectId))
      .for("update");
    const current = await tx.query.operations.findFirst({
      where: eq(operations.id, id),
    });
    if (current?.status === "completed") return;
    if (
      !member.length ||
      !project ||
      project.ownerId !== op.ownerId ||
      project.activeOperationId !== id ||
      project.currentVersionId !== op.baseVersionId ||
      expiresAt.getTime() <= Date.now()
    )
      throw new Error("Code edit is no longer authorized.");
    const summary = "Manual code changes";
    const [version] = await tx
      .insert(versions)
      .values({
        projectId: op.projectId,
        operationId: id,
        baseVersionId: op.baseVersionId,
        ...draft,
        summary,
        verifiedAt: new Date(),
      })
      .returning();
    await tx.insert(previews).values({
      projectId: op.projectId,
      versionId: version.id,
      operationId: id,
      sandboxName: sandboxName(id),
      status: "ready",
      expiresAt,
    });
    await tx
      .update(projects)
      .set({
        currentVersionId: version.id,
        activeOperationId: null,
        status: "preview_available",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, op.projectId));
    await tx
      .update(operations)
      .set({
        status: "completed",
        versionId: version.id,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(operations.id, id));
    await tx.insert(activity).values({
      projectId: op.projectId,
      eventKey: `version:${version.id}`,
      kind: "version",
      data: { versionId: version.id, summary },
    });
  });
}

export async function failCodeEdit(id: string, message: string) {
  const op = await database().query.operations.findFirst({
    where: eq(operations.id, id),
  });
  if (!op || op.kind !== "code_edit" || op.status === "completed") return;
  try {
    await (await Sandbox.get({ name: sandboxName(id) })).stop();
  } catch {
    /* The sandbox also has a bounded lifetime. */
  }
  await finishOperation(id, "failed", "failed", message);
}
