import { eveChannel, type EveChannelEvents } from "eve/channels/eve";
import { localDev, ForbiddenError, type AuthFn } from "eve/channels/auth";
import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import { requireProject } from "@eveable/core/access";
import { operations, sessions, projects } from "@eveable/core/schema";
import { verifyRuntimeToken, runtimeRouteAllowed } from "@eveable/core/tokens";
import { persistEvent } from "@eveable/core/projection";

export const appAuth: AuthFn<Request> = async (request) => {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!bearer) return null;
  try {
    const claims = await verifyRuntimeToken(bearer);
    if (
      !runtimeRouteAllowed(
        claims,
        request.method,
        new URL(request.url).pathname,
      )
    )
      throw new Error("scope");
    await requireProject(claims.userId, claims.projectId);
    const op = await database().query.operations.findFirst({
      where: and(
        eq(operations.id, claims.operationId),
        eq(operations.projectId, claims.projectId),
        eq(operations.ownerId, claims.userId),
      ),
    });
    if (!op || (claims.sessionId && op.sessionId !== claims.sessionId))
      throw new Error("operation");
    if (claims.sessionId) {
      const session = await database().query.sessions.findFirst({
        where: and(
          eq(sessions.id, claims.sessionId),
          eq(sessions.projectId, claims.projectId),
        ),
      });
      if (!session) throw new Error("session");
    }
    return {
      authenticator: "eveable",
      principalId: claims.userId,
      principalType: "user",
      attributes: { ...claims },
    };
  } catch {
    throw new ForbiddenError({ message: "Project access denied." });
  }
};
const eventNames = [
  "turn.started",
  "message.appended",
  "message.completed",
  "actions.requested",
  "action.result",
  "input.requested",
  "session.waiting",
  "session.completed",
  "turn.failed",
] as const;
const events: EveChannelEvents = {};
for (const type of eventNames)
  Object.assign(events, {
    [type]: async (
      data: unknown,
      channel: { continuationToken: string },
      ctx: {
        session: {
          id: string;
          auth: { current: { attributes?: Record<string, unknown> } | null };
        };
      },
    ) => {
      const attributes = ctx.session.auth.current?.attributes;
      const operationId = attributes?.operationId;
      if (typeof operationId !== "string") return;
      const op = await database().query.operations.findFirst({
        where: eq(operations.id, operationId),
      });
      if (!op) return;
      // Event callbacks expose the runtime's namespaced token. The HTTP client
      // must store the channel-local token: Eve adds this outer prefix on send.
      // Remove exactly one prefix, preserving any prefix in the raw token itself.
      const continuationToken = channel.continuationToken.replace(/^eve:/, "");
      if (type === "turn.started") {
        await database().transaction(async (tx) => {
          await tx
            .insert(sessions)
            .values({
              id: ctx.session.id,
              projectId: op.projectId,
              continuationToken,
            })
            .onConflictDoUpdate({
              target: sessions.id,
              set: {
                continuationToken,
                status: "streaming",
              },
            });
          await tx
            .update(projects)
            .set({ status: "streaming", updatedAt: new Date() })
            .where(
              and(
                eq(projects.id, op.projectId),
                eq(projects.activeOperationId, op.id),
              ),
            );
          await tx
            .update(operations)
            .set({ sessionId: ctx.session.id, status: "running" })
            .where(eq(operations.id, op.id));
        });
      }
      await persistEvent(
        ctx.session.id,
        { type, data },
        continuationToken,
      );
    },
  });
export default eveChannel({
  auth: [
    appAuth,
    ...(process.env.NODE_ENV !== "production" &&
    process.env.EVEABLE_ALLOW_LOCAL_TUI === "true"
      ? [localDev()]
      : []),
  ],
  uploadPolicy: "disabled",
  async onMessage(ctx) {
    const auth = ctx.eve.caller;
    if (auth?.authenticator !== "eveable") return { auth };
    const operationId = String(auth.attributes?.operationId ?? "");
    // A network/workflow retry cannot dispatch the same accepted operation twice.
    const admitted = await database()
      .update(operations)
      .set({ status: "dispatched" })
      .where(
        and(eq(operations.id, operationId), eq(operations.status, "queued")),
      )
      .returning();
    if (!admitted.length) return null;
    const op = admitted[0];
    return {
      auth,
      context: [
        `Eveable project operation ${op.kind}. Current saved version: ${op.baseVersionId ?? "none"}. For an edit or restore, call load_project_source before proposing or changing files. Restore target: ${op.kind === "restore" ? op.versionId : "none"}. The server enforces mutation authorization. After security review call save_project_version. Publishing is a separate user action; never deploy during a build.`,
      ],
    };
  },
  events,
});
