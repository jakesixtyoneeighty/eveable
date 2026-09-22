import { Client, ClientError } from "eve/client";
import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import { activity, operations, sessions } from "@eveable/core/schema";
import { requireOperation, operationSchema } from "@eveable/core/operations";
import { runtimeToken } from "@eveable/core/tokens";
import { persistEvent } from "@eveable/core/projection";
import { required } from "@eveable/core/errors";
export async function dispatchOperation(id: string) {
  const { op } = await requireOperation(id);
  if (op.status !== "queued") return; // Never replay a dispatch whose response may have been lost.
  const input = operationSchema.parse(op.payload);
  const saved = op.sessionId
    ? await database().query.sessions.findFirst({
        where: eq(sessions.id, op.sessionId),
      })
    : undefined;
  const client = new Client({
    host: required("EVE_RUNTIME_ORIGIN"),
    auth: {
      bearer: () =>
        runtimeToken({
          userId: op.ownerId,
          projectId: op.projectId,
          operationId: op.id,
          sessionId: op.sessionId ?? undefined,
          permission: "dispatch",
        }),
    },
  });
  const session = client.session(
    saved
      ? {
          sessionId: saved.id,
          continuationToken: saved.continuationToken,
          streamIndex: saved.streamIndex,
        }
      : undefined,
  );
  const text =
    input.kind === "message"
      ? input.message
      : input.kind === "restore"
        ? "Restore the server-authorized saved version. Use load_project_source and the validation pipeline, then save a new version."
        : input.kind === "approval"
          ? `${String(op.payload.approvalLabel ?? (op.approved ? "Approve and build" : "Stop"))}${op.payload.approvalLabel === "Revise design" ? ": " + input.notes : ""}`
          : "";
  await database()
    .insert(activity)
    .values({
      projectId: op.projectId,
      eventKey: `user:${id}`,
      kind: "user",
      data: { text },
    })
    .onConflictDoNothing();
  let response;
  try {
    // Eve invokes onMessage only when a continuation includes message text.
    // Always include the exact choice so its durable dispatch guard also covers approvals.
    response = await session.send({
      message: text,
      ...(input.kind === "approval"
        ? {
            inputResponses: [
              { requestId: input.requestId, optionId: input.optionId },
            ],
          }
        : {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (
      saved &&
      error instanceof ClientError &&
      [404, 410].includes(error.status)
    )
      await database()
        .update(sessions)
        .set({ status: "failed", pending: null })
        .where(eq(sessions.id, saved.id));
    throw error;
  }
  // Eve's continuation response deliberately omits this token; retain the original.
  const continuationToken =
    response.continuationToken ?? saved?.continuationToken;
  if (!continuationToken)
    throw new Error("Runtime omitted its continuation token.");
  await database()
    .insert(sessions)
    .values({
      id: response.sessionId,
      projectId: op.projectId,
      continuationToken,
    })
    .onConflictDoNothing();
  await database()
    .update(operations)
    .set({ sessionId: response.sessionId })
    .where(eq(operations.id, id));
}
export async function reconcileOperation(id: string) {
  const op = await database().query.operations.findFirst({
    where: eq(operations.id, id),
  });
  if (!op || ["completed", "failed", "blocked"].includes(op.status))
    return true;
  const session = op.sessionId
    ? await database().query.sessions.findFirst({
        where: eq(sessions.id, op.sessionId),
      })
    : undefined;
  if (!session) return false;
  const client = new Client({
    host: required("EVE_RUNTIME_ORIGIN"),
    auth: {
      bearer: () =>
        runtimeToken({
          userId: op.ownerId,
          projectId: op.projectId,
          operationId: id,
          sessionId: session.id,
          permission: "stream",
        }),
    },
    maxReconnectAttempts: 0,
  });
  const cursor = client.session({
    sessionId: session.id,
    continuationToken: session.continuationToken,
    streamIndex: session.streamIndex,
  });
  let index = session.streamIndex;
  try {
    for await (const event of cursor.stream({
      signal: AbortSignal.timeout(15000),
    })) {
      await persistEvent(session.id, event);
      index++;
      await database()
        .update(sessions)
        .set({ streamIndex: index })
        .where(
          and(eq(sessions.id, session.id), eq(sessions.streamIndex, index - 1)),
        );
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/abort|timeout/i.test(error.name + " " + error.message)
    )
      throw error;
  }
  const latest = await database().query.operations.findFirst({
    where: eq(operations.id, id),
  });
  return !latest || ["completed", "failed", "blocked"].includes(latest.status);
}
