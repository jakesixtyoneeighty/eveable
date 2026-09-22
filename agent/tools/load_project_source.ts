import { defineTool } from "eve/tools";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import { versions } from "@eveable/core/schema";
import { readArtifact } from "@eveable/core/artifacts";
import { projectOperation, recordManifest } from "../lib/project.js";
import {
  buildSandboxFilePath,
  generatedWorkspacePath,
} from "../lib/sandbox.js";
export default defineTool({
  description:
    "Read the current saved project source before planning an edit. Hydrates a fresh or previously failed sandbox from the authoritative version. For an approved restore, loads the exact requested version.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    const current = await projectOperation(ctx);
    if (!current) return { status: "not_managed", files: [] };
    const id =
      current.op.kind === "restore"
        ? current.op.versionId
        : current.op.baseVersionId;
    if (!id) return { status: "new_project", files: [] };
    const version = await database().query.versions.findFirst({
      where: and(
        eq(versions.id, id),
        eq(versions.projectId, current.project.id),
      ),
    });
    if (!version) throw new Error("Saved version not found.");
    const files = await readArtifact(version);
    const sandbox = await ctx.getSandbox();
    // Hydrating the approved baseline is recovery, not a model-authored mutation.
    await sandbox.removePath({
      path: generatedWorkspacePath,
      recursive: true,
      force: true,
    });
    for (const file of files)
      await sandbox.writeTextFile({
        path: buildSandboxFilePath(file.path),
        content: file.content,
      });
    await recordManifest(
      sandbox,
      files.map((f) => f.path),
    );
    return { status: "source_ready", versionId: id, files };
  },
});
