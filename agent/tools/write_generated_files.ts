import {
  projectOperation,
  readManifest,
  recordManifest,
} from "../lib/project.js";
import { canonicalSource } from "@eveable/core/artifacts";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { GeneratedFileSchema } from "../lib/schemas.js";
import {
  buildSandboxFilePath,
  generatedWorkspacePath,
} from "../lib/sandbox.js";

export default defineTool({
  description:
    "Write actual source contents into /workspace/generated-app. For repairs to a new build, pass only changed files with resetWorkspace:false to preserve other files. Never write generator manifest entries with empty contents. Use apply_project_changes for saved-base edits. Run run_quality_commands next.",
  inputSchema: z.object({
    files: z.array(GeneratedFileSchema).min(1),
    resetWorkspace: z.boolean().default(true),
  }),
  async execute({ files, resetWorkspace }, ctx) {
    const operation = await projectOperation(ctx, true);
    canonicalSource(files);
    const sandbox = await ctx.getSandbox();
    const previous = await readManifest(sandbox);
    if (operation?.op.baseVersionId) resetWorkspace = false;

    if (resetWorkspace) {
      await sandbox.removePath({
        path: generatedWorkspacePath,
        force: true,
        recursive: true,
      });
    }

    for (const file of files) {
      await sandbox.writeTextFile({
        path: buildSandboxFilePath(file.path),
        content: file.content,
      });
    }

    await recordManifest(sandbox, [
      ...(resetWorkspace ? [] : previous),
      ...files.map((file) => file.path),
    ]);
    return {
      agent: "sandbox" as const,
      status: "ready_for_review" as const,
      sandboxId: sandbox.id,
      workspacePath: generatedWorkspacePath,
      message: `Wrote ${files.length} generated file(s) into the sandbox.`,
      filesWritten: files.map((file) => file.path),
      notes: [
        "Generated files were written under /workspace/generated-app.",
        "This is not a completed build; run_quality_commands must run next.",
        "A public URL requires a separately confirmed Publish action after saving a verified source version.",
      ],
      nextRequiredTool: "run_quality_commands" as const,
    };
  },
});
