import { defineTool } from "eve/tools";
import { z } from "zod";
import { canonicalSource, safePath } from "@eveable/core/artifacts";
import {
  actualSource,
  projectOperation,
  recordManifest,
} from "../lib/project.js";
import { buildSandboxFilePath } from "../lib/sandbox.js";
export default defineTool({
  description:
    "Apply approved source-aware edits. Supply complete contents only for changed files and explicit deleted paths; preserve every other existing file. Run quality checks next.",
  inputSchema: z.object({
    files: z.array(z.object({ path: z.string(), content: z.string() })),
    deletedPaths: z.array(z.string()).default([]),
  }),
  async execute({ files, deletedPaths }, ctx) {
    await projectOperation(ctx, true);
    if (!deletedPaths.every(safePath)) throw new Error("Unsafe deletion path.");
    const sandbox = await ctx.getSandbox();
    const existing = await actualSource(sandbox);
    const next = new Map(existing.map((f) => [f.path, f]));
    for (const path of deletedPaths) next.delete(path);
    for (const file of files) next.set(file.path, file);
    const source = canonicalSource([...next.values()]);
    for (const path of deletedPaths)
      await sandbox.removePath({
        path: buildSandboxFilePath(path),
        force: true,
      });
    for (const file of files)
      await sandbox.writeTextFile({
        path: buildSandboxFilePath(file.path),
        content: file.content,
      });
    await recordManifest(
      sandbox,
      source.files.map((f) => f.path),
    );
    return {
      status: "needs_validation",
      files: source.files.map((f) => f.path),
      nextRequiredTool: "run_quality_commands",
    };
  },
});
