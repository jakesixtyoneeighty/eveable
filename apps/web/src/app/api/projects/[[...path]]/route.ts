import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { start } from "workflow/api";
import { database } from "@eveable/core/db";
import {
  projects,
  versions,
  activity,
  sessions,
  previews,
  operations,
  deployments,
} from "@eveable/core/schema";
import { admitOperation, operationSchema } from "@eveable/core/operations";
import { readArtifact } from "@eveable/core/artifacts";
import { previewGrant, previewOrigin } from "@eveable/core/preview";
import { AppError } from "@eveable/core/errors";
import { user, owned, mutation } from "@/lib/auth";
import { body, handled } from "@/lib/http";
import { runOperation } from "@/workflows/operations";
export const runtime = "nodejs";
export const maxDuration = 300;
type Context = { params: Promise<{ path?: string[] }> };
const json = (data: unknown) =>
  Response.json(data, { headers: { "cache-control": "no-store" } });
const publicVersion = (v: typeof versions.$inferSelect) => ({
  id: v.id,
  hash: v.hash,
  summary: v.summary,
  manifest: v.manifest,
  createdAt: v.createdAt,
  baseVersionId: v.baseVersionId,
});
async function route(request: Request, context: Context) {
  const path = (await context.params).path ?? [];
  if (request.method !== "GET") mutation(request);
  const db = database();
  if (!path.length) {
    const ownerId = await user();
    if (request.method === "GET")
      return json(
        await db
          .select({
            id: projects.id,
            name: projects.name,
            status: projects.status,
            archived: projects.archived,
            updatedAt: projects.updatedAt,
            currentVersionId: projects.currentVersionId,
          })
          .from(projects)
          .where(eq(projects.ownerId, ownerId))
          .orderBy(desc(projects.updatedAt))
          .limit(100),
      );
    if (request.method === "POST") {
      const input = z
        .object({ id: z.uuid(), name: z.string().trim().min(1).max(100) })
        .parse(await body(request));
      await db
        .insert(projects)
        .values({ id: input.id, ownerId, name: input.name })
        .onConflictDoNothing();
      const project = await owned(input.id);
      return json({ id: project.id });
    }
  }
  const project = await owned(z.uuid().parse(path[0]));
  if (path.length === 1) {
    if (request.method === "PATCH") {
      const input = z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          archived: z.boolean().optional(),
        })
        .parse(await body(request));
      const [updated] = await db
        .update(projects)
        .set({ ...input, updatedAt: new Date() })
        .where(
          and(eq(projects.id, project.id), isNull(projects.activeOperationId)),
        )
        .returning();
      if (!updated)
        throw new AppError(
          409,
          "busy",
          "Wait for the active operation before changing project settings.",
        );
      return json({ id: updated.id });
    }
    if (request.method === "GET") {
      const [saved, session, preview, release, op] = await Promise.all([
        db.query.versions.findMany({
          where: eq(versions.projectId, project.id),
          orderBy: desc(versions.createdAt),
        }),
        db.query.sessions.findFirst({
          where: eq(sessions.projectId, project.id),
          orderBy: desc(sessions.createdAt),
        }),
        db.query.previews.findFirst({
          where: eq(previews.projectId, project.id),
          orderBy: desc(previews.createdAt),
        }),
        db.query.deployments.findFirst({
          where: eq(deployments.projectId, project.id),
          orderBy: desc(deployments.createdAt),
        }),
        db.query.operations.findFirst({
          where: eq(operations.projectId, project.id),
          orderBy: desc(operations.createdAt),
        }),
      ]);
      return json({
        project: {
          id: project.id,
          name: project.name,
          status: project.status,
          archived: project.archived,
          currentVersionId: project.currentVersionId,
          publishedVersionId: project.publishedVersionId,
          deploymentUrl: project.deploymentUrl,
          busy: !!project.activeOperationId,
        },
        versions: saved.map(publicVersion),
        pending: session?.pending ?? [],
        preview: preview
          ? {
              id: preview.id,
              versionId: preview.versionId,
              status:
                preview.expiresAt && preview.expiresAt.getTime() < Date.now()
                  ? "expired"
                  : preview.status,
            }
          : null,
        release: release
          ? { status: release.status, url: release.productionUrl }
          : null,
        error: op?.error ?? null,
      });
    }
  }
  if (
    path[1] === "operations" &&
    path.length === 2 &&
    request.method === "POST"
  ) {
    const input = operationSchema.parse(await body(request));
    const op = await admitOperation(
      project.ownerId,
      project.id,
      request.headers.get("idempotency-key") ?? "",
      input,
    );
    if (op.status === "queued" && !op.workflowId) {
      const acquired = await db
        .update(operations)
        .set({ workflowId: "starting" })
        .where(and(eq(operations.id, op.id), isNull(operations.workflowId)))
        .returning();
      if (acquired.length) {
        try {
          const run = await start(runOperation, [op.id]);
          await db
            .update(operations)
            .set({ workflowId: run.runId })
            .where(eq(operations.id, op.id));
        } catch {
          await db
            .update(operations)
            .set({
              error:
                "Workflow dispatch could not be confirmed. Operator reconciliation is required; do not repeat this action.",
            })
            .where(eq(operations.id, op.id));
          throw new AppError(
            503,
            "dispatch_uncertain",
            "Workflow dispatch could not be confirmed. The operation is retained for reconciliation.",
          );
        }
      }
    }
    return json({ id: op.id, status: op.status });
  }
  if (path[1] === "stream" && request.method === "GET") {
    let after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(new URL(request.url).searchParams.get("after") ?? 0);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline && !request.signal.aborted) {
            await owned(project.id);
            const events = await db
              .select()
              .from(activity)
              .where(
                and(
                  eq(activity.projectId, project.id),
                  gt(activity.cursor, after),
                ),
              )
              .orderBy(asc(activity.cursor))
              .limit(200);
            for (const event of events) {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    id: event.id,
                    cursor: event.cursor,
                    kind: event.kind,
                    data: event.data,
                    createdAt: event.createdAt,
                  }) + "\n",
                ),
              );
              after = event.cursor;
            }
            if (events.length === 200) continue;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          controller.close();
        } catch {
          try {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  kind: "disconnected",
                  data: { text: "Reconnect to continue receiving updates." },
                }) + "\n",
              ),
            );
            controller.close();
          } catch {
            /* Client closed. */
          }
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }
  if (path[1] === "versions" && request.method === "GET") {
    const version = await db.query.versions.findFirst({
      where: and(
        eq(versions.id, z.uuid().parse(path[2])),
        eq(versions.projectId, project.id),
      ),
    });
    if (!version) throw new AppError(404, "not_found", "Version not found.");
    const files = await readArtifact(version);
    if (path[3] === "export") {
      const { zipSync, strToU8 } = await import("fflate");
      const archive = zipSync(
        Object.fromEntries(
          files.map((file) => [file.path, strToU8(file.content)]),
        ),
      );
      return new Response(Buffer.from(archive), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="eveable-${version.id}.zip"`,
          "cache-control": "no-store",
        },
      });
    }
    return json({ version: publicVersion(version), files });
  }
  if (path[1] === "preview-access" && request.method === "POST") {
    const input = z.object({ previewId: z.uuid() }).parse(await body(request));
    const preview = await db.query.previews.findFirst({
      where: and(
        eq(previews.id, input.previewId),
        eq(previews.projectId, project.id),
      ),
    });
    if (!preview) throw new AppError(404, "not_found", "Preview not found.");
    return json({
      origin: previewOrigin(preview.id),
      token: await previewGrant(project.ownerId, preview.id),
    });
  }
  throw new AppError(404, "not_found", "Route not found.");
}
export const GET = (r: Request, c: Context) => handled(() => route(r, c));
export const POST = GET;
export const PATCH = GET;
