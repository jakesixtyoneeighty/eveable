import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSource, safePath } from "@eveable/core/artifacts";
import {
  runtimeToken,
  verifyRuntimeToken,
  runtimeRouteAllowed,
} from "@eveable/core/tokens";
import {
  approvalChoice,
  positiveLimit,
  operationSchema,
} from "@eveable/core/operations";
import { requireOrigin } from "@eveable/core/access";
import { projectEvent } from "@eveable/core/projection";
import { safePreviewPath, previewOrigin } from "@eveable/core/preview";
import { verifiedVercelUrl } from "@eveable/core/publish";
import { conversation } from "../apps/web/src/lib/client";
afterEach(() => vi.unstubAllEnvs());
describe("trust boundaries", () => {
  it.each([
    "../secrets",
    "/etc/passwd",
    "app/../../.env",
    "app\\file",
    ".env.local",
    "node_modules/x",
    "app/.env",
    "app//x",
    ".git/config",
    ".vercel/project.json",
    "app/\u0000x",
  ])("rejects unsafe archive path %s", (path) =>
    expect(safePath(path)).toBe(false),
  );
  it("accepts Next route groups and dynamic paths", () =>
    expect(safePath("app/(marketing)/[slug]/page.tsx")).toBe(true));
  it("hashes canonical source independently of file order and rejects duplicates", () => {
    const a = { path: "a.ts", content: "one" },
      b = { path: "b.ts", content: "two" };
    expect(canonicalSource([a, b]).hash).toBe(canonicalSource([b, a]).hash);
    expect(() => canonicalSource([a, a])).toThrow();
    expect(() => canonicalSource([])).toThrow();
  });
  it("rejects runtime credentials inside source", () => {
    vi.stubEnv("CLERK_SECRET_KEY", "test_secret_do_not_export_12345");
    expect(() =>
      canonicalSource([
        { path: "app.ts", content: "test_secret_do_not_export_12345" },
      ]),
    ).toThrow("secret");
  });
  it("requires same-origin writes", () => {
    expect(() =>
      requireOrigin(
        new Request("https://app.example/api", {
          headers: { origin: "https://evil.example" },
        }),
        "https://app.example",
      ),
    ).toThrow();
    expect(() =>
      requireOrigin(
        new Request("https://app.example/api", {
          headers: { origin: "https://app.example" },
        }),
        "https://app.example",
      ),
    ).not.toThrow();
  });
  it("binds signed runtime requests to operation, session and route", async () => {
    vi.stubEnv(
      "EVEABLE_RUNTIME_SECRET",
      "unit-test-runtime-key-longer-than-32-characters",
    );
    const claims = {
      userId: "user_a",
      projectId: "00000000-0000-4000-8000-000000000001",
      operationId: "00000000-0000-4000-8000-000000000002",
      sessionId: "ses_a",
      permission: "stream" as const,
    };
    const token = await runtimeToken(claims);
    expect(await verifyRuntimeToken(token)).toEqual(claims);
    expect(
      runtimeRouteAllowed(claims, "GET", "/eve/v1/session/ses_a/stream"),
    ).toBe(true);
    expect(
      runtimeRouteAllowed(claims, "GET", "/eve/v1/session/ses_b/stream"),
    ).toBe(false);
    expect(runtimeRouteAllowed(claims, "POST", "/eve/v1/session/ses_a")).toBe(
      false,
    );
    await expect(verifyRuntimeToken(token + "broken")).rejects.toThrow();
  });
  it.each([
    "https://evil.example",
    "https://foo.vercel.app.evil.example",
    "http://foo.vercel.app",
    "https://a@foo.vercel.app",
    "https://foo.vercel.app/path",
  ])("rejects untrusted deployment URL %s", (url) =>
    expect(() => verifiedVercelUrl(url)).toThrow(),
  );
  it("accepts only bounded preview paths and an isolated origin", () => {
    expect(safePreviewPath("//evil.example")).toBe(false);
    expect(safePreviewPath("/a\\b")).toBe(false);
    expect(safePreviewPath("/_next/static/main.js")).toBe(true);
    vi.stubEnv("APP_ORIGIN", "https://builder.example");
    vi.stubEnv("PREVIEW_ORIGIN", "https://builder.example");
    expect(() => previewOrigin("test")).toThrow();
  });
});
describe("approval and state contracts", () => {
  const pending = [
    {
      requestId: "r",
      prompt: "Approve?",
      options: [
        { id: "yes", label: "Approve and build" },
        { id: "revise", label: "Revise design" },
        { id: "stop", label: "Stop" },
      ],
    },
  ];
  it("resolves the actual pending request and rejects stale or invented approval ids", () => {
    expect(approvalChoice(pending, "r", "yes")).toBe("Approve and build");
    expect(() => approvalChoice(pending, "old", "yes")).toThrow();
    expect(() => approvalChoice(pending, "r", "approve")).toThrow();
  });
  it.each(["0", "-1", "1.5", "NaN"])(
    "rejects invalid configured limit %s",
    (value) => expect(() => positiveLimit(value, 20)).toThrow(),
  );
  it("uses explicit positive defaults", () => {
    expect(positiveLimit(undefined, 20)).toBe(20);
    expect(positiveLimit("2", 20)).toBe(2);
  });
  it("requires an exact version hash and confirmation for publishing", () => {
    expect(
      operationSchema.safeParse({
        kind: "publish",
        versionId: crypto.randomUUID(),
        hash: "x",
        confirmed: true,
      }).success,
    ).toBe(false);
  });
  it("drops hidden reasoning and raw tool outputs", () => {
    expect(
      projectEvent({
        type: "reasoning.completed",
        data: { reasoning: "hidden" },
      }),
    ).toBeNull();
    expect(
      projectEvent({
        type: "action.result",
        data: { secret: "hidden", files: ["source"] },
      }),
    ).toBeNull();
  });
  it("projects supported approvals without raw tool action inputs", () => {
    const value = projectEvent({
      type: "input.requested",
      data: {
        requests: pending.map((p) => ({
          ...p,
          action: { input: { secret: "hidden" } },
        })),
      },
    });
    expect(value?.kind).toBe("approval");
    expect(JSON.stringify(value)).not.toContain("hidden");
  });
  it("does not infer completion from files or assistant text", () => {
    expect(
      projectEvent({
        type: "action.result",
        data: { status: "preview_ready" },
      }),
    ).toBeNull();
    expect(
      projectEvent({
        type: "message.completed",
        data: { message: "Done", stepIndex: 1, turnId: "t" },
      })?.kind,
    ).toBe("assistant");
  });
  it("replaces streamed text with its finalized message without duplication", () => {
    const events = [
      {
        id: "1",
        cursor: 1,
        kind: "assistant_delta",
        data: { messageId: "a", text: "Hel" },
        createdAt: "",
      },
      {
        id: "2",
        cursor: 2,
        kind: "assistant",
        data: { messageId: "a", text: "Hello" },
        createdAt: "",
      },
    ];
    expect(conversation(events)).toEqual([
      { id: "a", role: "assistant", text: "Hello", pending: false },
    ]);
  });
});
