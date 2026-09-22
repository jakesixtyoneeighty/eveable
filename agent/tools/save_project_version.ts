import { defineTool } from "eve/tools";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import { projects, versions, activity } from "@eveable/core/schema";
import { saveArtifact, canonicalSource } from "@eveable/core/artifacts";
import { actualSource, projectOperation } from "../lib/project.js";
import { commandInGeneratedWorkspace } from "../lib/sandbox.js";
import { reviewSource } from "./run_security_review.js";
export default defineTool({
  description:
    "Create a durable immutable project version after approval. Independently verifies the exact sandbox source with install, typecheck, build, HTTP preview health, and deterministic security review. Required before calling a web build ready to preview.",
  inputSchema: z.object({ summary: z.string().min(1).max(240) }),
  async execute({ summary }, ctx) {
    const current = await projectOperation(ctx, true);
    if (!current)
      return {
        status: "local_preview_only",
        message:
          "Local TUI build is available in its sandbox. Durable versions require the web project connection.",
      };
    const saved = await database().query.versions.findFirst({
      where: eq(versions.operationId, current.op.id),
    });
    if (saved)
      return {
        status: "preview_available",
        versionId: saved.id,
        hash: saved.hash,
      };
    const sandbox = await ctx.getSandbox();
    const before = canonicalSource(await actualSource(sandbox));
    for (const command of [
      "npm install --ignore-scripts --no-audit --no-fund",
      "npm run typecheck",
      "npm run build",
    ]) {
      const result = await sandbox.run({
        command: commandInGeneratedWorkspace(command),
      });
      if (result.exitCode !== 0)
        return {
          status: "validation_failed",
          message: "Version not saved: validation failed.",
          nextAgent: "autofix",
        };
    }
    const check = await sandbox.run({
      command: commandInGeneratedWorkspace(
        `node -e "fetch('http://127.0.0.1:4173').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
      ),
    });
    if (check.exitCode !== 0)
      return { status: "preview_failed", nextRequiredTool: "start_preview" };
    const after = canonicalSource(await actualSource(sandbox));
    if (before.hash !== after.hash)
      return {
        status: "blocked",
        message:
          "Source changed during validation. Review and validate the new source again.",
      };
    const review = reviewSource(
      after.files.map((f) => ({ ...f, purpose: "Generated source" })),
    );
    if (review.status !== "passed")
      return {
        status: "needs_fixes",
        findings: review.findings,
        nextAgent: "autofix",
      };
    const artifact = await saveArtifact(
      current.project.id,
      current.op.id,
      after.files,
    );
    await projectOperation(ctx, true); // Recheck membership and operation immediately before committing.
    const version = await database().transaction(async (tx) => {
      const [v] = await tx
        .insert(versions)
        .values({
          projectId: current.project.id,
          operationId: current.op.id,
          baseVersionId: current.op.baseVersionId,
          summary,
          verifiedAt: new Date(),
          ...artifact,
        })
        .onConflictDoNothing()
        .returning();
      if (!v)
        return tx.query.versions.findFirst({
          where: eq(versions.operationId, current.op.id),
        });
      await tx
        .update(projects)
        .set({ currentVersionId: v.id, updatedAt: new Date() })
        .where(
          and(
            eq(projects.id, current.project.id),
            eq(projects.activeOperationId, current.op.id),
          ),
        );
      await tx
        .insert(activity)
        .values({
          projectId: current.project.id,
          eventKey: `version:${v.id}`,
          kind: "version",
          data: { versionId: v.id, summary },
        })
        .onConflictDoNothing();
      return v;
    });
    return {
      status: "preview_available",
      versionId: version?.id,
      hash: artifact.hash,
      message:
        "Validated source version saved. The user can open the hosted preview or publish separately.",
    };
  },
});
