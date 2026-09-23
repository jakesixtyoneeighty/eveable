import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  requireOperation: vi.fn(),
}));
vi.mock("ai", () => ({
  generateText: mocks.generateText,
  Output: { object: (value: unknown) => value },
}));
vi.mock("@eveable/core/operations", () => ({
  requireOperation: mocks.requireOperation,
}));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
import generator from "../agent/tools/generate_next_app_from_spec.js";
import {
  assembleGeneratedApp,
  assertGeneratableSpec,
} from "../agent/lib/app-generation.js";
import {
  ImplementationSpecSchema,
  GeneratedAppBundleSchema,
} from "../agent/lib/schemas.js";
import { commandInGeneratedWorkspace } from "../agent/lib/sandbox.js";
import {
  editorialSpec,
  editorialOutput,
  calculatorSpec,
  calculatorOutput,
} from "./fixtures/generated-apps.js";

const sandbox = {
  id: "sandbox-test",
  removePath: vi.fn(),
  writeTextFile: vi.fn(),
  run: vi.fn(),
  spawn: vi.fn(),
};
const kill = vi.fn();
const ctx = {
  session: {
    id: "session-a",
    auth: {
      current: {
        authenticator: "eveable",
        principalId: "owner",
        attributes: { operationId: "operation-a" },
      },
    },
  },
  getSandbox: vi.fn(async () => sandbox),
};
const approved = {
  op: {
    id: "operation-a",
    sessionId: "session-a",
    ownerId: "owner",
    approved: true,
    baseVersionId: null,
  },
};
function modelResult(output: unknown = editorialOutput) {
  return { output, totalUsage: { inputTokens: 1000, outputTokens: 2200 } };
}
const run = (spec = editorialSpec) =>
  generator.execute!({ spec }, ctx as never);
function expectUntouched() {
  expect(ctx.getSandbox).not.toHaveBeenCalled();
  expect(sandbox.removePath).not.toHaveBeenCalled();
  expect(sandbox.writeTextFile).not.toHaveBeenCalled();
  expect(sandbox.run).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  ctx.getSandbox.mockResolvedValue(sandbox);
  mocks.requireOperation.mockResolvedValue(approved);
  mocks.generateText.mockResolvedValue(modelResult());
  sandbox.run.mockResolvedValue({ exitCode: 0, stdout: "passed", stderr: "" });
  sandbox.spawn.mockResolvedValue({ kill });
});
afterEach(() => vi.unstubAllEnvs());

describe("bespoke source generation", () => {
  it.each([
    [editorialSpec, editorialOutput],
    [calculatorSpec, calculatorOutput],
  ])(
    "passes the complete approved spec to generation and writes the returned application",
    async (spec, output) => {
      mocks.generateText.mockResolvedValueOnce(modelResult(output));
      const result = await run(spec);
      expect(result.status).toBe("preview_ready");
      expect(GeneratedAppBundleSchema.safeParse(result).success).toBe(true);
      const request = mocks.generateText.mock.calls[0][0];
      expect(JSON.parse(request.prompt)).toEqual(spec);
      expect(request).toMatchObject({
        maxRetries: 0,
        timeout: 180_000,
        maxOutputTokens: 32_000,
      });
      expect(request.system).not.toMatch(
        /Boutique plant|Moss and Circuit|Circuit Fern/,
      );
      for (const file of output.files)
        expect(sandbox.writeTextFile).toHaveBeenCalledWith({
          path: `generated-app/${file.path}`,
          content: file.content,
        });
      expect(result.files.every((file) => file.content === "")).toBe(true);
      expect(result.generation).toEqual({
        model: request.model,
        inputTokens: 1000,
        outputTokens: 2200,
      });
      expect(result.nextRequiredTool).toBe("read_generated_files");
      expect(mocks.requireOperation).toHaveBeenCalledTimes(2);
      expect(sandbox.run).toHaveBeenCalledTimes(4);
      expect(sandbox.run.mock.calls[0][0].command).toContain(
        "--ignore-scripts",
      );
    },
  );
  it("supplies build infrastructure without page content or stock images", () => {
    const files = assembleGeneratedApp(editorialSpec, editorialOutput);
    expect(
      files
        .filter(
          (file) =>
            !editorialOutput.files.some((source) => source.path === file.path),
        )
        .map((file) => file.path),
    ).toEqual([
      "package.json",
      "tsconfig.json",
      "next.config.ts",
      "next-env.d.ts",
    ]);
    const pkg = JSON.parse(
      files.find((file) => file.path === "package.json")!.content,
    );
    expect(pkg.scripts).toEqual({
      dev: "next dev",
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
    });
    expect(JSON.stringify(files)).not.toMatch(
      /images.unsplash|plant shop|repotting|Monstera/i,
    );
  });
  it("does not forward runtime integration credentials in sandbox commands", () => {
    vi.stubEnv("INSFORGE_API_KEY", "private-integration-key-never-forward");
    vi.stubEnv("INSFORGE_API_BASE_URL", "https://private.example");
    expect(commandInGeneratedWorkspace("npm run build")).not.toMatch(
      /INSFORGE|private/,
    );
  });
});

describe("generation admission and failure boundaries", () => {
  it("requires approval before the model call", async () => {
    mocks.requireOperation.mockResolvedValueOnce({
      op: { ...approved.op, approved: false },
    });
    await expect(run()).rejects.toThrow("approval");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expectUntouched();
  });
  it("rejects saved-base projects before the model call", async () => {
    mocks.requireOperation.mockResolvedValueOnce({
      op: { ...approved.op, baseVersionId: "saved" },
    });
    await expect(run()).rejects.toThrow("Existing projects");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expectUntouched();
  });
  it("rechecks authorization after generation before any file mutation", async () => {
    mocks.requireOperation
      .mockResolvedValueOnce(approved)
      .mockRejectedValueOnce(new Error("Membership revoked"));
    await expect(run()).rejects.toThrow("revoked");
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expectUntouched();
  });
  it.each([
    { ...editorialSpec, status: "blocked" as const },
    { ...editorialSpec, brief: "" },
    { ...editorialSpec, pages: [editorialSpec.pages[1]] },
    {
      ...editorialSpec,
      pages: [editorialSpec.pages[0], editorialSpec.pages[0]],
    },
    { ...editorialSpec, imageUrls: ["http://images.example/photo.jpg"] },
    {
      ...editorialSpec,
      imageUrls: ["https://user:password@images.example/photo.jpg"],
    },
  ])(
    "rejects blocked, incomplete, or invalid specs without generation",
    async (spec) => {
      const result = await run(spec);
      expect(result.status).toBe("blocked");
      expect(result.nextRequiredTool).toBe("user_action");
      expect(mocks.generateText).not.toHaveBeenCalled();
      expectUntouched();
    },
  );
  it("blocks a credential in the spec before sending it to a model", async () => {
    vi.stubEnv("TEST_PLATFORM_SECRET", "secret-should-not-reach-provider");
    expect(
      (
        await run({
          ...editorialSpec,
          brief: "secret-should-not-reach-provider",
        })
      ).status,
    ).toBe("blocked");
    expect(mocks.generateText).not.toHaveBeenCalled();
    expectUntouched();
  });
  it("does not fabricate a spec from loosely shaped input", () => {
    expect(
      ImplementationSpecSchema.safeParse({ brandName: "Anything" }).success,
    ).toBe(false);
    expect(() =>
      assertGeneratableSpec({ ...editorialSpec, status: "blocked" }),
    ).toThrow("blocked");
  });
  it.each([
    undefined,
    {
      files: editorialOutput.files.filter(
        (file) => file.path !== "app/archives/page.tsx",
      ),
    },
    { files: [...editorialOutput.files, editorialOutput.files[0]] },
    {
      files: [
        ...editorialOutput.files,
        {
          path: "package.json",
          content: '{"scripts":{"postinstall":"bad"}}',
          purpose: "override",
        },
      ],
    },
    {
      files: [
        ...editorialOutput.files,
        { path: "app/../../escape.ts", content: "escape", purpose: "escape" },
      ],
    },
    {
      files: [
        ...editorialOutput.files,
        { path: "app/.env.local", content: "secret", purpose: "env" },
      ],
    },
    {
      files: [
        ...editorialOutput.files,
        {
          path: "lib/unsafe.ts",
          content: 'eval("untrusted")',
          purpose: "unsafe",
        },
      ],
    },
    {
      files: [
        ...editorialOutput.files,
        {
          path: "lib/oversize.ts",
          content: "x".repeat(38_001),
          purpose: "oversize",
        },
      ],
    },
  ])(
    "blocks invalid generated source before resetting the workspace",
    async (output) => {
      mocks.generateText.mockResolvedValueOnce({ ...modelResult(), output });
      const result = await run();
      expect(result.status).toBe("blocked");
      expect(result.files).toEqual([]);
      expectUntouched();
    },
  );
  it("blocks generated platform secrets without echoing them", async () => {
    vi.stubEnv("TEST_PLATFORM_SECRET", "platform-secret-must-not-be-written");
    mocks.generateText.mockResolvedValueOnce(
      modelResult({
        files: [
          ...editorialOutput.files,
          {
            path: "lib/content.ts",
            purpose: "data",
            content: 'export const data="platform-secret-must-not-be-written"',
          },
        ],
      }),
    );
    const result = await run();
    expect(result.status).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain(
      "platform-secret-must-not-be-written",
    );
    expectUntouched();
  });
  it("returns a safe failure and never a template or automatic retry on provider error", async () => {
    mocks.generateText.mockRejectedValueOnce(
      new Error("provider-error-private-details"),
    );
    const result = await run();
    expect(result.status).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain(
      "provider-error-private-details",
    );
    expect(mocks.generateText).toHaveBeenCalledTimes(1);
    expectUntouched();
  });
  it.each([1, null])(
    "stops before preview when quality exit code is %s",
    async (exitCode) => {
      sandbox.run.mockResolvedValueOnce({
        exitCode,
        stdout: "failure",
        stderr: "failed",
      });
      const result = await run();
      expect(result.status).toBe("validation_failed");
      expect(result.validation.buildStatus.install).toBe("failed");
      expect(result.nextRequiredTool).toBe("autofix");
      expect(result.files.length).toBeGreaterThan(0);
      expect(sandbox.spawn).not.toHaveBeenCalled();
    },
  );
  it("routes unhealthy preview to source-aware repair", async () => {
    sandbox.run
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "not ready" });
    const result = await run();
    expect(result.status).toBe("preview_failed");
    expect(result.nextRequiredTool).toBe("autofix");
    expect(kill).toHaveBeenCalledOnce();
  });
});
