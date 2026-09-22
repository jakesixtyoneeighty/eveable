import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  approved: true,
  files: new Map<string, string>(),
  requireOperation: vi.fn(),
}));
vi.mock("@eveable/core/operations", () => ({
  requireOperation: mocks.requireOperation,
}));
vi.mock("eve/tools", () => ({
  defineTool: (definition: unknown) => definition,
}));
import edit from "../agent/tools/apply_project_changes";
import { canonicalSource } from "@eveable/core/artifacts";
const base = "/workspace/generated-app/";
const sandbox = {
  run: vi.fn(async () => ({ exitCode: 0 })),
  readTextFile: vi.fn(
    async ({ path }: { path: string }) =>
      mocks.files.get(path.startsWith("/") ? path : "/workspace/" + path) ??
      null,
  ),
  writeTextFile: vi.fn(
    async ({ path, content }: { path: string; content: string }) => {
      mocks.files.set(
        path.startsWith("/") ? path : "/workspace/" + path,
        content,
      );
    },
  ),
  removePath: vi.fn(async ({ path }: { path: string }) => {
    mocks.files.delete(path.startsWith("/") ? path : "/workspace/" + path);
  }),
};
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
  getSandbox: async () => sandbox,
};
describe("approved source edits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.files = new Map([
      [
        base + ".eveable-manifest.json",
        JSON.stringify(["app/page.tsx", "app/layout.tsx", "app/old.tsx"]),
      ],
      [base + "app/page.tsx", "original page"],
      [base + "app/layout.tsx", "unrelated layout"],
      [base + "app/old.tsx", "explicit deletion"],
    ]);
    mocks.requireOperation.mockResolvedValue({
      op: {
        id: "operation-a",
        sessionId: "session-a",
        ownerId: "owner",
        approved: true,
      },
    });
  });
  it("changes selected files, preserves unrelated bytes, and records explicit deletions", async () => {
    await edit.execute!(
      {
        files: [{ path: "app/page.tsx", content: "edited page" }],
        deletedPaths: ["app/old.tsx"],
      },
      ctx as never,
    );
    expect(mocks.files.get(base + "app/page.tsx")).toBe("edited page");
    expect(mocks.files.get(base + "app/layout.tsx")).toBe("unrelated layout");
    expect(mocks.files.has(base + "app/old.tsx")).toBe(false);
    expect(
      JSON.parse(mocks.files.get(base + ".eveable-manifest.json")!),
    ).toEqual(["app/layout.tsx", "app/page.tsx"]);
  });
  it("cannot write without server-side approval or delete outside the workspace", async () => {
    mocks.requireOperation.mockResolvedValueOnce({
      op: { sessionId: "session-a", ownerId: "owner", approved: false },
    });
    await expect(
      edit.execute!(
        {
          files: [{ path: "app/page.tsx", content: "unauthorized" }],
          deletedPaths: [],
        },
        ctx as never,
      ),
    ).rejects.toThrow("approval");
    await expect(
      edit.execute!({ files: [], deletedPaths: ["../secret"] }, ctx as never),
    ).rejects.toThrow("Unsafe");
    expect(sandbox.writeTextFile).not.toHaveBeenCalled();
    expect(sandbox.removePath).not.toHaveBeenCalled();
  });
  it("rejects platform credentials before any edit is written", async () => {
    vi.stubEnv("TEST_PLATFORM_SECRET", "platform-secret-value-for-test");
    try {
      expect(() =>
        canonicalSource([
          { path: "app/page.tsx", content: "platform-secret-value-for-test" },
        ]),
      ).toThrow("runtime secret");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
