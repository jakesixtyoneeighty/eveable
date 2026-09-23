import { projectOperation, recordManifest } from "../lib/project.js";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  GeneratedAppBundleSchema,
  ImplementationSpecSchema,
  QualityPlanSchema,
} from "../lib/schemas.js";
import {
  buildSandboxFilePath,
  applyBuildStatus,
  commandInGeneratedWorkspace,
  createInitialBuildStatus,
  generatedWorkspacePath,
  normalizeCommandResult,
  normalizePreviewCommand,
  normalizeQualityCommands,
  redactSensitive,
} from "../lib/sandbox.js";

import { generateApplication } from "../lib/app-generation.js";

const inputSchema = z.object({ spec: ImplementationSpecSchema });

export default defineTool({
  description:
    "Generate bespoke Next.js pages, components, and styles from an approved ImplementationSpec using the configured code model, write source in generated-app, then validate and start preview. No fixed visual template. Use only for new builds. CodeWriter returns a spec, never source files. Returned files are empty-content manifests. A blocked result leaves the workspace untouched; do not blindly retry generation.",
  inputSchema,
  outputSchema: GeneratedAppBundleSchema,
  async execute({ spec: rawSpec }, ctx) {
    const operation = await projectOperation(ctx, true);
    if (operation?.op.baseVersionId)
      throw new Error(
        "Existing projects must use apply_project_changes, not regeneration.",
      );
    const spec = rawSpec;
    const qualityPlan = buildQualityPlan();
    let generated: Awaited<ReturnType<typeof generateApplication>>;
    try {
      generated = await generateApplication(spec);
    } catch {
      // Provider/schema errors may contain raw generated source or credentials.
      // A generation failure must not clear or partially write the workspace.
      return {
        agent: "app_generator" as const,
        status: "blocked" as const,
        message:
          "Source generation was blocked, failed, or returned incomplete/unsafe output. No project files were changed. Check the approved spec and model configuration before a deliberate retry.",
        sandboxId: "",
        workspacePath: generatedWorkspacePath,
        files: [],
        qualityPlan,
        validation: {
          commands: [],
          commandResults: [],
          buildStatus: createInitialBuildStatus(),
        },
        preview: emptyPreview(qualityPlan.previewPort),
        notes: [
          "No template fallback was used. Do not call autofix without generated source or automatically repeat an uncertain provider call.",
        ],
        nextRequiredTool: "user_action" as const,
      };
    }
    // Generation can take minutes. Recheck approval/membership before mutation.
    const latestOperation = await projectOperation(ctx, true);
    if (latestOperation?.op.baseVersionId)
      throw new Error(
        "Existing projects must use apply_project_changes, not regeneration.",
      );
    const { files, generation } = generated;
    const sandbox = await ctx.getSandbox();
    const validation = {
      commands: normalizeQualityCommands(files, qualityPlan),
      commandResults: [] as Array<ReturnType<typeof normalizeCommandResult>>,
      buildStatus: createInitialBuildStatus(),
    };

    await sandbox.removePath({
      path: generatedWorkspacePath,
      force: true,
      recursive: true,
    });

    for (const file of files) {
      await sandbox.writeTextFile({
        path: buildSandboxFilePath(file.path),
        content: file.content,
      });
    }
    await recordManifest(
      sandbox,
      files.map((file) => file.path),
    );

    for (const command of validation.commands) {
      const result = await sandbox.run({
        command: commandInGeneratedWorkspace(command),
      });
      const normalizedResult = normalizeCommandResult(command, result);
      validation.commandResults.push(normalizedResult);
      applyBuildStatus(
        validation.buildStatus,
        command,
        normalizedResult.exitCode,
      );

      if (normalizedResult.exitCode !== 0) {
        return {
          agent: "app_generator" as const,
          status: "validation_failed" as const,
          message:
            "Generated files were written, but a quality command failed.",
          sandboxId: sandbox.id,
          workspacePath: generatedWorkspacePath,
          files: manifestFiles(files),
          qualityPlan,
          generation,
          validation,
          preview: emptyPreview(qualityPlan.previewPort),
          notes: [
            "Call autofix with the validation result and generated source snapshot.",
          ],
          nextRequiredTool: "autofix" as const,
        };
      }
    }

    const previewCommand = normalizePreviewCommand(
      qualityPlan.previewCommand,
      qualityPlan.previewPort,
    );
    const processHandle = await sandbox.spawn({
      command: commandInGeneratedWorkspace(previewCommand),
    });
    const probeCommand = buildProbeCommand(qualityPlan.previewPort);
    const probeResult = await sandbox.run({
      command: commandInGeneratedWorkspace(probeCommand),
    });
    const previewOk = probeResult.exitCode === 0;

    if (!previewOk && typeof processHandle.kill === "function") {
      await processHandle.kill();
    }

    return {
      agent: "app_generator" as const,
      status: previewOk
        ? ("preview_ready" as const)
        : ("preview_failed" as const),
      message: previewOk
        ? "Generated, validated, and started the Next.js preview successfully."
        : "Generated files validated, but preview health check failed.",
      sandboxId: sandbox.id,
      workspacePath: generatedWorkspacePath,
      files: manifestFiles(files),
      qualityPlan,
      generation,
      validation,
      preview: {
        ok: previewOk,
        command: redactSensitive(previewCommand),
        port: qualityPlan.previewPort,
        probeCommand: redactSensitive(probeCommand),
        stdout: redactSensitive(probeResult.stdout ?? ""),
        stderr: redactSensitive(probeResult.stderr ?? ""),
      },
      notes: [
        "Generated bespoke application source from the approved implementation spec.",
        "Files were written directly to /workspace/generated-app.",
        previewOk
          ? "Call read_generated_files next, then run_security_review, then save_project_version. Publishing requires a separate web confirmation."
          : "Call autofix with the preview result, then validate and preview again.",
      ],
      nextRequiredTool: previewOk
        ? ("read_generated_files" as const)
        : ("autofix" as const),
    };
  },
});

function manifestFiles(files: Array<{ path: string; purpose: string }>) {
  return files.map((file) => ({
    path: file.path,
    purpose: file.purpose,
    content: "",
  }));
}

function emptyPreview(port: number) {
  return {
    ok: false,
    command: null,
    port,
    probeCommand: null,
    stdout: "",
    stderr: "",
  };
}

function buildProbeCommand(port: number): string {
  return [
    `for i in $(seq 1 60); do`,
    `node -e "fetch('http://127.0.0.1:${port}').then(r=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))"`,
    "&& exit 0;",
    "sleep 2;",
    "done;",
    `echo 'Preview did not respond on port ${port}' >&2;`,
    "exit 1",
  ].join(" ");
}

function buildQualityPlan(): z.infer<typeof QualityPlanSchema> {
  return {
    packageManager: "npm",
    commands: [
      "npm install --ignore-scripts --no-audit --no-fund",
      "npm run typecheck",
      "npm run build",
    ],
    previewCommand: "npm run dev -- -H 0.0.0.0 -p 4173",
    previewPort: 4173,
    autofixAgentRequired: true,
    codeReviewAgentRequired: true,
  };
}
