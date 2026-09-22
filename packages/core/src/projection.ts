import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import {
  activity,
  operations,
  projects,
  sessions,
  versions,
  type ApprovalRequest,
} from "@eveable/core/schema";
export type RuntimeEvent = { type: string; data?: unknown };
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const stages: Record<string, string> = {
  intent: "Understanding request",
  orchestrator: "Planning",
  design_research: "Researching design",
  code_writer: "Preparing implementation",
  generate_next_app_from_spec: "Building",
  apply_project_changes: "Applying changes",
  run_quality_commands: "Checking build",
  start_preview: "Checking preview",
  read_generated_files: "Reading source",
  run_security_review: "Reviewing security",
  save_project_version: "Saving version",
  autofix: "Repairing build",
};
export function projectEvent(
  event: RuntimeEvent,
): { kind: string; data: Record<string, unknown> } | null {
  const d = record(event.data);
  if (event.type === "message.appended" || event.type === "message.completed") {
    const text =
      typeof d.message === "string"
        ? d.message
        : typeof d.messageSoFar === "string"
          ? d.messageSoFar
          : "";
    // Never serialize parts, reasoning, tool calls or arbitrary event fields.
    return text
      ? {
          kind:
            event.type === "message.completed"
              ? "assistant"
              : "assistant_delta",
          data: {
            text: text.slice(0, 24000),
            messageId: `${d.turnId ?? "current"}:${d.stepIndex ?? 0}`,
          },
        }
      : null;
  }
  if (event.type === "input.requested") {
    const requests: ApprovalRequest[] = [];
    for (const raw of Array.isArray(d.requests) ? d.requests : []) {
      const r = record(raw);
      const options = (Array.isArray(r.options) ? r.options : [])
        .map((o) => {
          const v = record(o);
          return {
            id: String(v.id ?? v.optionId ?? ""),
            label: String(v.label ?? ""),
          };
        })
        .filter(
          (o) =>
            o.id &&
            ["Approve and build", "Revise design", "Stop"].includes(o.label),
        );
      if (typeof r.requestId === "string" && options.length === 3)
        requests.push({
          requestId: r.requestId,
          prompt: String(r.prompt ?? "Review the design.").slice(0, 12000),
          options,
        });
    }
    return requests.length
      ? { kind: "approval", data: { requests } }
      : {
          kind: "blocked",
          data: {
            text: "The agent requested an unsupported approval. Operator attention is required.",
          },
        };
  }
  if (event.type === "actions.requested") {
    const names =
      JSON.stringify(d).match(new RegExp(Object.keys(stages).join("|"), "g")) ??
      [];
    return {
      kind: "stage",
      data: { label: stages[names[0] ?? ""] ?? "Working" },
    };
  }
  if (event.type === "action.result") {
    const result = record(d.result);
    const output = record(result.output);
    if (
      result.toolName === "save_project_version" &&
      ["blocked", "validation_failed", "preview_failed"].includes(
        String(output.status),
      )
    )
      return {
        kind: "blocked",
        data: {
          text: "The candidate did not pass the required checks. The last saved version is unchanged.",
        },
      };
  }
  if (event.type === "session.waiting") return { kind: "waiting", data: {} };
  if (event.type === "session.completed")
    return { kind: "completed", data: {} };
  if (event.type === "session.failed" || event.type === "turn.failed")
    return {
      kind: "failed",
      data: {
        text: "The run failed. Your last saved version is unchanged. You can send a new request.",
      },
    };
  return null;
}
export async function persistEvent(
  sessionId: string,
  event: RuntimeEvent,
  continuationToken?: string,
) {
  const session = await database().query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });
  if (!session) return;
  const projected = projectEvent(event);
  if (!projected) return;
  const eventKey = createHash("sha256")
    .update(sessionId + JSON.stringify({ type: event.type, data: event.data }))
    .digest("hex");
  await database().transaction(async (tx) => {
    const inserted = await tx
      .insert(activity)
      .values({ projectId: session.projectId, eventKey, ...projected })
      .onConflictDoNothing()
      .returning({ id: activity.id });
    if (!inserted.length) return;
    if (projected.kind === "approval")
      await tx
        .update(sessions)
        .set({ pending: projected.data.requests as ApprovalRequest[] })
        .where(eq(sessions.id, sessionId));
    if (["waiting", "completed", "failed"].includes(projected.kind)) {
      await tx
        .update(sessions)
        .set({
          status: projected.kind,
          ...(continuationToken ? { continuationToken } : {}),
        })
        .where(eq(sessions.id, sessionId));
      const p = await tx.query.projects.findFirst({
        where: eq(projects.id, session.projectId),
      });
      if (p?.activeOperationId) {
        const op = await tx.query.operations.findFirst({
          where: eq(operations.id, p.activeOperationId),
        });
        if (
          op &&
          ["message", "approval", "restore"].includes(op.kind) &&
          op.sessionId === sessionId
        ) {
          const current = await tx.query.sessions.findFirst({
            where: eq(sessions.id, sessionId),
          });
          const saved = op.approved
            ? await tx.query.versions.findFirst({
                where: eq(versions.operationId, op.id),
              })
            : undefined;
          const unverified = op.approved && !saved && !current?.pending?.length;
          const state = unverified
            ? "blocked"
            : projected.kind === "failed"
              ? "failed"
              : current?.pending?.length
                ? "awaiting_approval"
                : p.currentVersionId
                  ? "preview_available"
                  : projected.kind;
          await tx
            .update(operations)
            .set({
              status: unverified
                ? "blocked"
                : projected.kind === "failed"
                  ? "failed"
                  : "completed",
              error: unverified
                ? "The candidate was not saved because its required checks did not complete. Your last saved version is unchanged."
                : null,
              updatedAt: new Date(),
            })
            .where(eq(operations.id, op.id));
          await tx
            .update(projects)
            .set({
              activeOperationId: null,
              status: state,
              updatedAt: new Date(),
            })
            .where(
              and(eq(projects.id, p.id), eq(projects.activeOperationId, op.id)),
            );
        }
      }
    }
  });
}
