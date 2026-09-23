import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { database } from "@eveable/core/db";
import {
  members,
  projects,
  operations,
  sessions,
  versions,
  deployments,
  type ApprovalRequest,
} from "@eveable/core/schema";
import { AppError } from "@eveable/core/errors";
import {
  canonicalSource,
  readArtifact,
  saveArtifact,
  sourceSchema,
} from "@eveable/core/artifacts";
export const operationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    message: z.string().trim().min(1).max(16000),
  }),
  z.object({
    kind: z.literal("approval"),
    requestId: z.string().min(1),
    optionId: z.string().min(1),
    notes: z.string().max(8000).default(""),
  }),
  z.object({ kind: z.literal("restore"), versionId: z.uuid() }),
  z.object({ kind: z.literal("preview"), versionId: z.uuid() }),
  z.object({
    kind: z.literal("code_edit"),
    versionId: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    files: sourceSchema,
  }),
  z.object({
    kind: z.literal("publish"),
    versionId: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  }),
]);
export type OperationInput = z.infer<typeof operationSchema>;
export function approvalChoice(
  pending: ApprovalRequest[] | null,
  requestId: string,
  optionId: string,
) {
  const request = pending?.find((r) => r.requestId === requestId);
  const choice = request?.options.find((o) => o.id === optionId);
  if (
    !choice ||
    !["Approve and build", "Revise design", "Stop"].includes(choice.label)
  )
    throw new AppError(
      409,
      "stale_approval",
      "This approval is no longer available. Reload the project.",
    );
  return choice.label;
}
export function positiveLimit(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error("Operation limits must be positive integers.");
  return n;
}
export async function admitOperation(
  userId: string,
  projectId: string,
  key: string,
  input: OperationInput,
) {
  input = operationSchema.parse(input);
  const edits =
    input.kind === "code_edit" ? canonicalSource(input.files) : null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key))
    throw new AppError(
      400,
      "idempotency_required",
      "An idempotency key is required.",
    );
  return database().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    );
    const member = await tx.query.members.findFirst({
      where: and(eq(members.userId, userId), eq(members.active, true)),
    });
    if (!member)
      throw new AppError(
        403,
        "membership_required",
        "Active membership is required.",
      );
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
      .for("update");
    if (!project) throw new AppError(404, "not_found", "Project not found.");
    const existing = await tx.query.operations.findFirst({
      where: and(eq(operations.projectId, projectId), eq(operations.key, key)),
    });
    if (existing) {
      if (
        input.kind === "code_edit"
          ? existing.kind !== "code_edit" ||
            existing.payload.versionId !== input.versionId ||
            existing.payload.hash !== input.hash ||
            existing.payload.requestHash !== edits?.hash
          : existing.kind === "code_edit" ||
            JSON.stringify(operationSchema.parse(existing.payload)) !==
              JSON.stringify(input)
      )
        throw new AppError(
          409,
          "key_reused",
          "Use a new idempotency key for a different request.",
        );
      return existing;
    }
    if (project.archived)
      throw new AppError(
        409,
        "archived",
        "Restore the archived project before making changes.",
      );
    if (project.activeOperationId)
      throw new AppError(
        409,
        "busy",
        "Wait for the current operation to finish.",
      );
    const session = await tx.query.sessions.findFirst({
      where: eq(sessions.projectId, projectId),
      orderBy: desc(sessions.createdAt),
    });
    if (
      session?.pending?.length &&
      input.kind !== "approval" &&
      input.kind !== "preview"
    )
      throw new AppError(
        409,
        "approval_pending",
        "Answer the pending design approval first.",
      );
    let approved = false;
    let approvalLabel: string | undefined;
    if (input.kind === "approval") {
      if (session?.status !== "waiting")
        throw new AppError(
          409,
          "not_waiting",
          "The agent is not waiting for approval.",
        );
      const label = approvalChoice(
        session.pending,
        input.requestId,
        input.optionId,
      );
      approvalLabel = label;
      if (label === "Revise design" && !input.notes.trim())
        throw new AppError(
          400,
          "notes_required",
          "Describe the design revision.",
        );
      approved = label === "Approve and build";
    }
    if (input.kind === "restore") approved = true; // The explicit restore confirmation authorizes this exact archive.
    if (input.kind === "code_edit") approved = true; // Save & Preview authorizes these exact file changes.
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    if (
      input.kind === "message" ||
      input.kind === "restore" ||
      input.kind === "code_edit" ||
      input.kind === "approval"
    ) {
      const other = await tx.query.projects.findFirst({
        where: and(
          eq(projects.ownerId, userId),
          sql`${projects.activeOperationId} is not null`,
        ),
      });
      if (other)
        throw new AppError(
          409,
          "user_busy",
          "Another project is already running.",
        );
    }
    if (["message", "restore", "code_edit", "publish"].includes(input.kind)) {
      const daily = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(operations)
        .where(
          and(
            eq(operations.ownerId, userId),
            gte(operations.createdAt, day),
            input.kind === "publish"
              ? eq(operations.kind, "publish")
              : sql`${operations.kind} in ('message','restore','code_edit')`,
          ),
        );
      const limit =
        input.kind === "publish"
          ? positiveLimit(process.env.EVEABLE_DAILY_PUBLISH_LIMIT, 10)
          : positiveLimit(process.env.EVEABLE_DAILY_BUILD_LIMIT, 20);
      if (daily[0].count >= limit)
        throw new AppError(
          429,
          "daily_limit",
          "Daily operation limit reached. Try again tomorrow.",
        );
    }
    if (input.kind === "publish") {
      const uncertain = await tx.query.deployments.findFirst({
        where: and(
          eq(deployments.projectId, projectId),
          eq(deployments.status, "promotion_unverified"),
        ),
      });
      if (uncertain)
        throw new AppError(
          409,
          "release_uncertain",
          "An operator must reconcile the previous promotion before publishing again.",
        );
    }
    let version;
    if ("versionId" in input) {
      version = await tx.query.versions.findFirst({
        where: and(
          eq(versions.id, input.versionId),
          eq(versions.projectId, projectId),
        ),
      });
      if (!version) throw new AppError(404, "not_found", "Version not found.");
      if (
        (input.kind === "publish" || input.kind === "code_edit") &&
        (version.hash !== input.hash || project.currentVersionId !== version.id)
      )
        throw new AppError(
          409,
          "version_changed",
          "The current version changed. Open the latest version before continuing.",
        );
    }
    const operationId = crypto.randomUUID();
    let payload: Record<string, unknown> = {
      ...input,
      ...(approvalLabel ? { approvalLabel } : {}),
    };
    if (input.kind === "code_edit" && version && edits) {
      const original = await readArtifact(version);
      const files = new Map(original.map((file) => [file.path, file]));
      for (const file of edits.files) {
        if (!files.has(file.path))
          throw new AppError(
            400,
            "unknown_file",
            "Only existing source files can be edited.",
          );
        files.set(file.path, file);
      }
      const candidate = canonicalSource([...files.values()]);
      if (candidate.hash === version.hash)
        throw new AppError(
          400,
          "unchanged",
          "There are no source changes to save.",
        );
      // Keep source in private Blob storage, never in operation/activity records.
      const draft = await saveArtifact(projectId, operationId, candidate.files);
      payload = {
        kind: input.kind,
        versionId: input.versionId,
        hash: input.hash,
        requestHash: edits.hash,
        draft,
      };
    }
    const [op] = await tx
      .insert(operations)
      .values({
        id: operationId,
        projectId,
        ownerId: userId,
        key,
        kind: input.kind,
        payload,
        approved,
        baseVersionId: project.currentVersionId,
        versionId: version?.id,
        sessionId: session?.status === "waiting" ? session.id : null,
      })
      .returning();
    await tx
      .update(projects)
      .set({
        activeOperationId: op.id,
        status:
          input.kind === "publish"
            ? "publishing"
            : input.kind === "preview"
              ? "starting_preview"
              : input.kind === "code_edit"
                ? "validating_code"
                : "queued",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
    if (input.kind === "approval" && session)
      await tx
        .update(sessions)
        .set({ pending: null })
        .where(eq(sessions.id, session.id));
    if (input.kind === "publish" && version)
      await tx.insert(deployments).values({
        projectId,
        versionId: version.id,
        operationId: op.id,
        sourceHash: version.hash,
        authorizedBy: userId,
      });
    return op;
  });
}
export async function requireOperation(id: string) {
  const op = await database().query.operations.findFirst({
    where: eq(operations.id, id),
  });
  if (!op) throw new AppError(404, "not_found", "Operation not found.");
  const [project, member] = await Promise.all([
    database().query.projects.findFirst({
      where: eq(projects.id, op.projectId),
    }),
    database().query.members.findFirst({
      where: and(eq(members.userId, op.ownerId), eq(members.active, true)),
    }),
  ]);
  if (
    !project ||
    !member ||
    project.ownerId !== op.ownerId ||
    project.activeOperationId !== id
  )
    throw new AppError(
      409,
      "operation_inactive",
      "This operation is no longer authorized.",
    );
  return { op, project };
}
export async function finishOperation(
  id: string,
  status: "completed" | "failed" | "blocked",
  projectStatus: string,
  error?: string,
) {
  await database().transaction(async (tx) => {
    const existing = await tx.query.operations.findFirst({
      where: eq(operations.id, id),
    });
    if (!existing || existing.status === "completed") return;
    const [op] = await tx
      .update(operations)
      .set({ status, error: error ?? null, updatedAt: new Date() })
      .where(eq(operations.id, id))
      .returning();
    if (op)
      await tx
        .update(projects)
        .set({
          activeOperationId: null,
          status: projectStatus,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projects.id, op.projectId),
            eq(projects.activeOperationId, id),
          ),
        );
  });
}
