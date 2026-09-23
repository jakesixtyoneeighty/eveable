import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { database, closeDatabase } from "@eveable/core/db";
import {
  members,
  projects,
  operations,
  sessions,
  activity,
  versions,
  previews,
  deployments,
  terminals,
  terminalCommands,
} from "@eveable/core/schema";
import { requireMember, requireProject } from "@eveable/core/access";
import { admitOperation, finishOperation } from "@eveable/core/operations";
import { persistEvent } from "@eveable/core/projection";
import { canonicalSource } from "@eveable/core/artifacts";
import {
  admitTerminal,
  admitTerminalCommand,
  stopTerminal,
  terminalState,
} from "@eveable/core/terminal";
import {
  prepareTerminal,
  executeTerminalCommand,
} from "@eveable/core/terminal-runtime";
const mocks = vi.hoisted(() => ({
  source: "",
  artifacts: new Map<string, string>(),
  runner: { mkDir: vi.fn(), writeFiles: vi.fn(), runCommand: vi.fn() },
  sandbox: {
    createUser: vi.fn(),
    asUser: vi.fn(),
    updateNetworkPolicy: vi.fn(),
    runCommand: vi.fn(),
    writeFiles: vi.fn(),
    stop: vi.fn(),
    status: "running",
  },
  user: "user_a",
}));
vi.mock("@vercel/blob", () => ({
  get: vi.fn(async (path: string) => ({
    statusCode: 200,
    stream: new Response(mocks.artifacts.get(path) ?? mocks.source).body,
  })),
  put: vi.fn(async (path: string, body: string) => {
    mocks.artifacts.set(path, body);
    return { pathname: path };
  }),
}));
vi.mock("@vercel/sandbox", () => ({
  APIError: class APIError extends Error {
    response = { status: 500 };
  },
  Sandbox: {
    getOrCreate: vi.fn(async () => mocks.sandbox),
    get: vi.fn(async () => mocks.sandbox),
  },
}));
vi.mock("../apps/web/node_modules/workflow/dist/api.js", () => ({
  start: vi.fn(async () => ({ runId: "workflow-test" })),
}));
vi.mock("../apps/web/src/lib/auth", async () => {
  const access = await import("@eveable/core/access");
  return {
    user: async () => (await access.requireMember(mocks.user)).userId,
    owned: async (id: string) => access.requireProject(mocks.user, id),
    mutation: (request: Request) =>
      access.requireOrigin(request, "https://app.test"),
  };
});
const suite = process.env.EVEABLE_TEST_DATABASE_URL ? describe : describe.skip;
suite("Postgres-backed access, operations, and provider adapters", () => {
  let a: string, b: string;
  beforeAll(async () => {
    const url = process.env.EVEABLE_TEST_DATABASE_URL!;
    if (!new URL(url).pathname.endsWith("/eveable_test"))
      throw new Error(
        "Integration tests require a disposable database named eveable_test.",
      );
    process.env.DATABASE_URL = url;
    await migrate(database(), { migrationsFolder: "packages/core/migrations" });
  });
  beforeEach(async () => {
    await database().execute(
      sql`truncate terminal_commands, terminals, deployments, previews, versions, activity, project_sessions, operations, projects, members restart identity cascade`,
    );
    await database()
      .insert(members)
      .values([
        { userId: "user_a" },
        { userId: "user_b" },
        { userId: "user_revoked", active: false },
      ]);
    const p = await database()
      .insert(projects)
      .values([
        { ownerId: "user_a", name: "A" },
        { ownerId: "user_b", name: "B" },
      ])
      .returning();
    a = p[0].id;
    b = p[1].id;
    mocks.user = "user_a";
    mocks.artifacts.clear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.env.DATABASE_URL = process.env.EVEABLE_TEST_DATABASE_URL!;
    mocks.sandbox.runCommand.mockReset().mockResolvedValue({
      exitCode: 0,
      stdout: async () =>
        JSON.stringify({
          status: 200,
          headers: { "content-type": "text/html" },
          body: Buffer.from("<p>Hello</p>").toString("base64"),
        }),
    });
    mocks.sandbox.writeFiles.mockReset().mockResolvedValue(undefined);
    mocks.sandbox.stop.mockReset().mockResolvedValue({ status: "stopped" });
    mocks.sandbox.createUser.mockReset().mockResolvedValue(undefined);
    mocks.sandbox.asUser.mockReset().mockReturnValue(mocks.runner);
    mocks.sandbox.updateNetworkPolicy.mockReset().mockResolvedValue(undefined);
    mocks.runner.mkDir.mockReset().mockResolvedValue(undefined);
    mocks.runner.writeFiles.mockReset().mockResolvedValue(undefined);
    mocks.runner.runCommand
      .mockReset()
      .mockImplementation(async () => detached());
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await closeDatabase();
  });
  it("rejects anonymous, uninvited, revoked and cross-user access", async () => {
    await expect(requireMember(null)).rejects.toMatchObject({ status: 401 });
    await expect(requireMember("user_unknown")).rejects.toMatchObject({
      status: 403,
    });
    await expect(requireMember("user_revoked")).rejects.toMatchObject({
      status: 403,
    });
    await expect(requireProject("user_b", a)).rejects.toMatchObject({
      status: 404,
    });
    expect((await requireProject("user_a", a)).id).toBe(a);
  });
  it("admits a repeated request once and rejects changed payloads under the same key", async () => {
    const input = { kind: "message" as const, message: "Build a studio" };
    const key = crypto.randomUUID();
    const [first, second] = await Promise.all([
      admitOperation("user_a", a, key, input),
      admitOperation("user_a", a, key, input),
    ]);
    expect(first.id).toBe(second.id);
    expect(await database().select().from(operations)).toHaveLength(1);
    await expect(
      admitOperation("user_a", a, key, { ...input, message: "Different" }),
    ).rejects.toMatchObject({ code: "key_reused" });
  });
  it("serializes competing operations and enforces one active project per user", async () => {
    const results = await Promise.allSettled([
      admitOperation("user_a", a, crypto.randomUUID(), {
        kind: "message",
        message: "First",
      }),
      admitOperation("user_a", a, crypto.randomUUID(), {
        kind: "message",
        message: "Second",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [other] = await database()
      .insert(projects)
      .values({ ownerId: "user_a", name: "Other" })
      .returning();
    await expect(
      admitOperation("user_a", other.id, crypto.randomUUID(), {
        kind: "message",
        message: "Parallel",
      }),
    ).rejects.toMatchObject({ code: "user_busy" });
    await expect(
      admitOperation("user_b", b, crypto.randomUUID(), {
        kind: "message",
        message: "Independent",
      }),
    ).resolves.toBeDefined();
  });
  it("enforces durable daily admission limits", async () => {
    vi.stubEnv("EVEABLE_DAILY_BUILD_LIMIT", "1");
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "message",
      message: "One",
    });
    await finishOperation(op.id, "completed", "waiting");
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        kind: "message",
        message: "Two",
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it("persists approval while no browser is connected, replays safely, and consumes it once", async () => {
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "message",
      message: "Build",
    });
    await database().insert(sessions).values({
      id: "session-a",
      projectId: a,
      continuationToken: "server-only",
    });
    await database()
      .update(operations)
      .set({ sessionId: "session-a" })
      .where(eq(operations.id, op.id));
    const event = {
      type: "input.requested",
      data: {
        requests: [
          {
            requestId: "question",
            prompt: "Approve design?",
            options: [
              { id: "build", label: "Approve and build" },
              { id: "revise", label: "Revise design" },
              { id: "stop", label: "Stop" },
            ],
          },
        ],
      },
    };
    await persistEvent("session-a", event);
    await persistEvent("session-a", event);
    await persistEvent("session-a", {
      type: "session.waiting",
      data: { turnId: "turn-1" },
    });
    expect(await database().select().from(activity)).toHaveLength(2);
    expect(
      (await database().query.projects.findFirst({ where: eq(projects.id, a) }))
        ?.status,
    ).toBe("awaiting_approval");
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        kind: "message",
        message: "Ignore approval",
      }),
    ).rejects.toMatchObject({ code: "approval_pending" });
    const approved = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "approval",
      requestId: "question",
      optionId: "build",
      notes: "",
    });
    expect(approved.approved).toBe(true);
    await finishOperation(approved.id, "completed", "waiting");
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        kind: "approval",
        requestId: "question",
        optionId: "build",
        notes: "",
      }),
    ).rejects.toMatchObject({ code: "stale_approval" });
  });
  async function version(projectId = a, userId = "user_a") {
    const op = await admitOperation(userId, projectId, crypto.randomUUID(), {
      kind: "message",
      message: "Build",
    });
    const source = canonicalSource([
      { path: "package.json", content: '{"scripts":{"build":"next build"}}' },
      {
        path: "app/page.tsx",
        content: "export default function Page(){return <p>Hello</p>}",
      },
    ]);
    mocks.source = source.body;
    const [v] = await database()
      .insert(versions)
      .values({
        projectId,
        operationId: op.id,
        hash: source.hash,
        blobPath: "private/test.json",
        manifest: source.files.map((f) => f.path),
        summary: "First version",
        verifiedAt: new Date(),
      })
      .returning();
    await database()
      .update(projects)
      .set({ currentVersionId: v.id })
      .where(eq(projects.id, projectId));
    await finishOperation(op.id, "completed", "preview_available");
    return v;
  }
  it("denies source, export, versions, preview access and mutations through cross-user browser API routes", async () => {
    const v = await version();
    mocks.user = "user_b";
    const route =
      await import("../apps/web/src/app/api/projects/[[...path]]/route");
    for (const path of [
      [a],
      [a, "versions", v.id],
      [a, "versions", v.id, "export"],
      [a, "stream"],
    ])
      expect(
        (
          await route.GET(
            new Request("https://app.test/api/projects/" + path.join("/")),
            { params: Promise.resolve({ path }) },
          )
        ).status,
      ).toBe(404);
    const response = await route.POST(
      new Request("https://app.test/api/projects/" + a + "/operations", {
        method: "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ kind: "restore", versionId: v.id }),
      }),
      { params: Promise.resolve({ path: [a, "operations"] }) },
    );
    expect(response.status).toBe(404);
  });
  it("keeps tokens and private archive paths out of project detail responses", async () => {
    await version();
    await database().insert(sessions).values({
      id: "session",
      projectId: a,
      continuationToken: "do-not-expose-this",
    });
    const route =
      await import("../apps/web/src/app/api/projects/[[...path]]/route");
    const response = await route.GET(
      new Request("https://app.test/api/projects/" + a),
      { params: Promise.resolve({ path: [a] }) },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("do-not-expose-this");
    expect(text).not.toContain("private/test.json");
  });
  it("requires a current exact version for publication and does not overwrite the live version on failed changes", async () => {
    const v = await version();
    await database()
      .update(projects)
      .set({ publishedVersionId: v.id })
      .where(eq(projects.id, a));
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        kind: "publish",
        versionId: v.id,
        hash: "0".repeat(64),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "version_changed" });
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "message",
      message: "Edit",
    });
    await finishOperation(op.id, "failed", "failed");
    const p = await database().query.projects.findFirst({
      where: eq(projects.id, a),
    });
    expect(p?.currentVersionId).toBe(v.id);
    expect(p?.publishedVersionId).toBe(v.id);
  });
  it("creates an isolated, unexposed preview and rejects expired or revoked access", async () => {
    const v = await version();
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "preview",
      versionId: v.id,
    });
    const { startPreview, previewGrant, verifyPreviewGrant } =
      await import("@eveable/core/preview");
    const { Sandbox } = await import("@vercel/sandbox");
    await startPreview(op.id);
    expect(Sandbox.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ports: [],
        persistent: false,
        env: { CI: "true", NEXT_TELEMETRY_DISABLED: "1" },
      }),
    );
    const p = await database().query.previews.findFirst({
      where: eq(previews.operationId, op.id),
    });
    expect(p?.status).toBe("ready");
    vi.stubEnv(
      "EVEABLE_PREVIEW_SECRET",
      "test-preview-key-at-least-32-characters-long",
    );
    vi.stubEnv("APP_ORIGIN", "https://app.test");
    vi.stubEnv("PREVIEW_ORIGIN", "https://preview.test");
    const token = await previewGrant("user_a", p!.id);
    expect((await verifyPreviewGrant(token, p!.id, false)).userId).toBe(
      "user_a",
    );
    await expect(verifyPreviewGrant(token, p!.id, true)).rejects.toThrow();
    await database()
      .update(members)
      .set({ active: false })
      .where(eq(members.userId, "user_a"));
    await expect(verifyPreviewGrant(token, p!.id, false)).rejects.toThrow();
    await database()
      .update(members)
      .set({ active: true })
      .where(eq(members.userId, "user_a"));
    await database()
      .update(previews)
      .set({ expiresAt: new Date(0) })
      .where(eq(previews.id, p!.id));
    await expect(previewGrant("user_a", p!.id)).rejects.toMatchObject({
      status: 410,
    });
  });
  it("publishes immutable files with no runtime secrets, verifies the candidate, then promotes", async () => {
    const v = await version();
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "publish",
      versionId: v.id,
      hash: v.hash,
      confirmed: true,
    });
    vi.stubEnv("VERCEL_TOKEN", "unit-test-only-vercel-token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_test");
    let promoted = false;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.host.endsWith(".vercel.app")) return new Response("healthy");
        if (url.pathname.endsWith("/env")) return Response.json({ envs: [] });
        if (url.pathname === "/v13/deployments" && init?.method === "POST")
          return Response.json({ id: "dpl_test", url: "candidate.vercel.app" });
        if (url.pathname === "/v13/deployments/dpl_test")
          return Response.json({
            id: "dpl_test",
            url: "candidate.vercel.app",
            readyState: "READY",
            alias: promoted ? [`eveable-${a}.vercel.app`] : [],
          });
        if (url.pathname.includes("/promote/")) {
          promoted = true;
          return Response.json({});
        }
        return Response.json({
          id: "prj_test",
          targets: promoted ? { production: { id: "dpl_test" } } : {},
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createRelease, checkRelease } =
      await import("@eveable/core/publish");
    await createRelease(op.id);
    await createRelease(op.id);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/v13/deployments?") && init?.method === "POST",
      ),
    ).toHaveLength(1);
    const submitted = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("/v13/deployments?") && init?.method === "POST",
    )!;
    expect(String(submitted[1]?.body)).not.toContain(
      "unit-test-only-vercel-token",
    );
    expect(String(submitted[1]?.body)).not.toContain("buildEnv");
    expect(await checkRelease(op.id)).toBe(false);
    expect(promoted).toBe(true);
    expect(await checkRelease(op.id)).toBe(true);
    expect(
      (
        await database().query.deployments.findFirst({
          where: eq(deployments.operationId, op.id),
        })
      )?.status,
    ).toBe("published");
  });
  it("retains Eve continuation tokens and sends the exact approval through the dispatch guard", async () => {
    vi.stubEnv(
      "EVEABLE_RUNTIME_SECRET",
      "test-runtime-secret-at-least-thirty-two-characters",
    );
    vi.stubEnv("EVE_RUNTIME_ORIGIN", "https://runtime.test");
    await database()
      .insert(sessions)
      .values({
        id: "resume-session",
        projectId: a,
        continuationToken: "private-continuation",
        status: "waiting",
        pending: [
          {
            requestId: "approve",
            prompt: "Review",
            options: [
              { id: "yes", label: "Approve and build" },
              { id: "revise", label: "Revise design" },
              { id: "no", label: "Stop" },
            ],
          },
        ],
      });
    const key = crypto.randomUUID();
    const input = {
      kind: "approval" as const,
      requestId: "approve",
      optionId: "yes",
      notes: "",
    };
    const op = await admitOperation("user_a", a, key, input);
    expect((await admitOperation("user_a", a, key, input)).id).toBe(op.id);
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, sessionId: "resume-session" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { dispatchOperation } = await import("../apps/web/src/lib/runtime");
    await dispatchOperation(op.id);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain("/eve/v1/session/resume-session");
    expect(JSON.parse(String(call[1].body))).toMatchObject({
      message: "Approve and build",
      continuationToken: "private-continuation",
      inputResponses: [{ requestId: "approve", optionId: "yes" }],
    });
    expect(
      (
        await database().query.sessions.findFirst({
          where: eq(sessions.id, "resume-session"),
        })
      )?.continuationToken,
    ).toBe("private-continuation");
  });
  it("denies direct runtime access across operation, session, identity and membership boundaries", async () => {
    vi.stubEnv(
      "EVEABLE_RUNTIME_SECRET",
      "test-runtime-secret-at-least-thirty-two-characters",
    );
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "message",
      message: "Hello",
    });
    const { runtimeToken } = await import("@eveable/core/tokens");
    const { appAuth } = await import("../agent/channels/eve");
    const token = await runtimeToken({
      userId: "user_a",
      projectId: a,
      operationId: op.id,
      permission: "dispatch",
    });
    const request = (path = "/eve/v1/session", bearer = token) =>
      new Request("https://runtime.test" + path, {
        method: "POST",
        headers: { authorization: "Bearer " + bearer },
      });
    expect((await appAuth(request()))?.principalId).toBe("user_a");
    await expect(
      appAuth(request("/eve/v1/session/some-other-session")),
    ).rejects.toThrow();
    await expect(
      appAuth(request("/eve/v1/session", "infrastructure-token")),
    ).rejects.toThrow();
    const foreign = await runtimeToken({
      userId: "user_b",
      projectId: a,
      operationId: op.id,
      permission: "dispatch",
    });
    await expect(
      appAuth(request("/eve/v1/session", foreign)),
    ).rejects.toThrow();
    await database()
      .update(members)
      .set({ active: false })
      .where(eq(members.userId, "user_a"));
    await expect(appAuth(request())).rejects.toThrow();
  });
  it("does not mistake a finished unvalidated edit for a saved version", async () => {
    const v = await version();
    await database()
      .insert(sessions)
      .values({
        id: "unvalidated",
        projectId: a,
        continuationToken: "private",
        status: "waiting",
        pending: [
          {
            requestId: "q",
            prompt: "Review",
            options: [{ id: "y", label: "Approve and build" }],
          },
        ],
      });
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "approval",
      requestId: "q",
      optionId: "y",
      notes: "",
    });
    await persistEvent("unvalidated", {
      type: "session.completed",
      data: { turnId: "failed-candidate" },
    });
    const p = await database().query.projects.findFirst({
      where: eq(projects.id, a),
    });
    expect(p?.status).toBe("blocked");
    expect(p?.currentVersionId).toBe(v.id);
    expect(
      (
        await database().query.operations.findFirst({
          where: eq(operations.id, op.id),
        })
      )?.status,
    ).toBe("blocked");
  });
  it("protects generated assets and strips platform cookies in the preview gateway", async () => {
    const v = await version();
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "preview",
      versionId: v.id,
    });
    const { startPreview, previewGrant, previewOrigin } =
      await import("@eveable/core/preview");
    await startPreview(op.id);
    const p = (await database().query.previews.findFirst({
      where: eq(previews.operationId, op.id),
    }))!;
    vi.stubEnv(
      "EVEABLE_PREVIEW_SECRET",
      "test-preview-key-at-least-32-characters-long",
    );
    vi.stubEnv("APP_ORIGIN", "https://app.test");
    vi.stubEnv("PREVIEW_ORIGIN", "https://preview.test");
    const gateway =
      await import("../apps/web/src/app/api/preview-gateway/[id]/[[...path]]/route");
    const origin = previewOrigin(p.id);
    const context = {
      params: Promise.resolve({
        id: p.id,
        path: ["_next", "static", "app.js"],
      }),
    };
    expect(
      (
        await gateway.GET(
          new Request(origin + "/_next/static/app.js", {
            headers: { host: new URL(origin).host },
          }),
          context,
        )
      ).status,
    ).toBe(403);
    const token = await previewGrant("user_a", p.id, true);
    const response = await gateway.GET(
      new Request(origin + "/_next/static/app.js", {
        headers: {
          host: new URL(origin).host,
          cookie:
            "eveable_preview=" + token + "; platform-secret=do-not-forward",
          authorization: "Bearer never-forward",
        },
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://app.test",
    );
    const last = mocks.sandbox.runCommand.mock.calls.at(-1)![0];
    const data = JSON.parse(Buffer.from(last.args.at(-1), "base64").toString());
    expect(data.path).toBe("/_next/static/app.js");
    expect(data.headers).not.toHaveProperty("cookie");
    expect(data.headers).not.toHaveProperty("authorization");
  });
  it("blocks uncertain promotion and reconciles the actual production target before retry", async () => {
    const v = await version();
    const op = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "publish",
      versionId: v.id,
      hash: v.hash,
      confirmed: true,
    });
    await database()
      .update(projects)
      .set({ vercelProjectId: "prj_test" })
      .where(eq(projects.id, a));
    await database()
      .update(deployments)
      .set({ status: "promoting", providerId: "dpl_new" })
      .where(eq(deployments.operationId, op.id));
    const { failRelease, reconcileRelease } =
      await import("@eveable/core/publish");
    await failRelease(op.id);
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        kind: "publish",
        versionId: v.id,
        hash: v.hash,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "release_uncertain" });
    vi.stubEnv("VERCEL_TOKEN", "test-token");
    vi.stubEnv("VERCEL_TEAM_ID", "team_test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).includes("api.vercel.com")
          ? Response.json({ targets: { production: { id: "dpl_new" } } })
          : new Response("healthy"),
      ),
    );
    expect((await reconcileRelease(op.id)).status).toBe("published");
    expect(
      (await database().query.projects.findFirst({ where: eq(projects.id, a) }))
        ?.publishedVersionId,
    ).toBe(v.id);
  });
  async function codeEdit(
    content = "export default function Page(){return <p>Edited</p>}",
  ) {
    const v = await version();
    const input = {
      kind: "code_edit" as const,
      versionId: v.id,
      hash: v.hash,
      files: [{ path: "app/page.tsx", content }],
    };
    const key = crypto.randomUUID();
    const op = await admitOperation("user_a", a, key, input);
    return { op, v, input, key };
  }
  it("stores manual drafts privately, preserves unrelated source, and admits a repeated save once", async () => {
    const { op, input, key } = await codeEdit();
    expect((await admitOperation("user_a", a, key, input)).id).toBe(op.id);
    expect(op.payload).not.toHaveProperty("files");
    expect(JSON.stringify(op.payload)).not.toContain("<p>Edited</p>");
    const { readArtifact } = await import("@eveable/core/artifacts");
    const draft = await readArtifact(
      op.payload.draft as { blobPath: string; hash: string },
    );
    expect(draft.find((f) => f.path === "package.json")?.content).toBe(
      '{"scripts":{"build":"next build"}}',
    );
    expect(draft.find((f) => f.path === "app/page.tsx")?.content).toContain(
      "Edited",
    );
    await expect(
      admitOperation("user_a", a, key, {
        ...input,
        files: [{ path: "app/page.tsx", content: "different" }],
      }),
    ).rejects.toMatchObject({ code: "key_reused" });
  });
  it("rejects stale, foreign, unsafe, unchanged, and unknown-file manual saves", async () => {
    const v = await version();
    const input = {
      kind: "code_edit" as const,
      versionId: v.id,
      hash: v.hash,
      files: [{ path: "app/page.tsx", content: "new" }],
    };
    await expect(
      admitOperation("user_b", a, crypto.randomUUID(), input),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        ...input,
        hash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "version_changed" });
    for (const path of ["../escape", ".env", "app/../page.tsx"])
      await expect(
        admitOperation("user_a", a, crypto.randomUUID(), {
          ...input,
          files: [{ path, content: "new" }],
        }),
      ).rejects.toMatchObject({ code: "unsafe_source" });
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        ...input,
        files: [{ path: "new.ts", content: "new" }],
      }),
    ).rejects.toMatchObject({ code: "unknown_file" });
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), {
        ...input,
        files: [
          {
            path: "app/page.tsx",
            content: "export default function Page(){return <p>Hello</p>}",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "unchanged" });
    expect(mocks.artifacts.size).toBe(0);
  });
  it("counts manual saves against daily build limits and rejects a pending AI approval", async () => {
    const v = await version();
    const input = {
      kind: "code_edit" as const,
      versionId: v.id,
      hash: v.hash,
      files: [{ path: "app/page.tsx", content: "new" }],
    };
    vi.stubEnv("EVEABLE_DAILY_BUILD_LIMIT", "1");
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), input),
    ).rejects.toMatchObject({ code: "daily_limit" });
    vi.stubEnv("EVEABLE_DAILY_BUILD_LIMIT", "20");
    await database()
      .insert(sessions)
      .values({
        id: "waiting-edit",
        projectId: a,
        continuationToken: "private",
        status: "waiting",
        pending: [
          {
            requestId: "q",
            prompt: "Approve?",
            options: [{ id: "yes", label: "Approve and build" }],
          },
        ],
      });
    await expect(
      admitOperation("user_a", a, crypto.randomUUID(), input),
    ).rejects.toMatchObject({ code: "approval_pending" });
  });
  it("commits a checked manual version and its private preview atomically, with replay protection", async () => {
    const { op, v } = await codeEdit();
    const { runCodeEditPhase, sourceHashProgram, failCodeEdit } =
      await import("@eveable/core/code-edit");
    mocks.sandbox.runCommand.mockImplementation(async (command) => ({
      exitCode: 0,
      stdout: async () =>
        command.args?.includes(sourceHashProgram)
          ? (op.payload.draft as { hash: string }).hash
          : "",
    }));
    for (const phase of [
      "prepare",
      "install",
      "typecheck",
      "build",
      "verify",
    ] as const)
      await runCodeEditPhase(op.id, phase);
    await runCodeEditPhase(op.id, "verify");
    await failCodeEdit(op.id, "late failure");
    const saved = await database().query.versions.findMany({
      where: eq(versions.operationId, op.id),
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].baseVersionId).toBe(v.id);
    const p = await database().query.projects.findFirst({
      where: eq(projects.id, a),
    });
    expect(p).toMatchObject({
      currentVersionId: saved[0].id,
      publishedVersionId: null,
      activeOperationId: null,
    });
    expect(
      await database().query.previews.findFirst({
        where: eq(previews.operationId, op.id),
      }),
    ).toMatchObject({
      versionId: saved[0].id,
      status: "ready",
      sandboxName: `eveable-code-${op.id}`,
    });
    expect(mocks.sandbox.stop).not.toHaveBeenCalled();
    const next = await admitOperation("user_a", a, crypto.randomUUID(), {
      kind: "message",
      message: "Edit this design",
    });
    expect(next.baseVersionId).toBe(saved[0].id);
  });
  it.each(["install", "typecheck", "build", "health", "readback", "security"])(
    "retains the previous version when manual %s validation fails",
    async (failure) => {
      const { op, v } = await codeEdit(
        failure === "security"
          ? "export default function Page(){ return eval('1'); }"
          : undefined,
      );
      const { runCodeEditPhase, sourceHashProgram, failCodeEdit } =
        await import("@eveable/core/code-edit");
      mocks.sandbox.runCommand.mockImplementation(async (command) => ({
        exitCode:
          failure === "security" || failure === "readback"
            ? 0
            : command.detached
              ? 0
              : 1,
        stdout: async () =>
          command.args?.includes(sourceHashProgram) && failure !== "readback"
            ? (op.payload.draft as { hash: string }).hash
            : "wrong-hash",
      }));
      const phase = ["health", "readback", "security"].includes(failure)
        ? "verify"
        : (failure as "install" | "typecheck" | "build");
      await expect(runCodeEditPhase(op.id, phase)).rejects.toThrow();
      await failCodeEdit(op.id, "Validation failed");
      expect(
        (
          await database().query.projects.findFirst({
            where: eq(projects.id, a),
          })
        )?.currentVersionId,
      ).toBe(v.id);
      expect(
        await database().query.versions.findMany({
          where: eq(versions.operationId, op.id),
        }),
      ).toHaveLength(0);
      expect(await database().select().from(previews)).toHaveLength(0);
      expect(mocks.sandbox.stop).toHaveBeenCalled();
    },
  );
  it("rechecks membership after manual validation and before committing", async () => {
    const { op, v } = await codeEdit();
    const { runCodeEditPhase, sourceHashProgram } =
      await import("@eveable/core/code-edit");
    mocks.sandbox.runCommand.mockImplementation(async (command) => {
      if (command.args?.includes(sourceHashProgram))
        await database()
          .update(members)
          .set({ active: false })
          .where(eq(members.userId, "user_a"));
      return {
        exitCode: 0,
        stdout: async () => (op.payload.draft as { hash: string }).hash,
      };
    });
    await expect(runCodeEditPhase(op.id, "verify")).rejects.toThrow();
    expect(
      (await database().query.projects.findFirst({ where: eq(projects.id, a) }))
        ?.currentVersionId,
    ).toBe(v.id);
    expect(
      await database().query.versions.findMany({
        where: eq(versions.operationId, op.id),
      }),
    ).toHaveLength(0);
  });
  it("enforces same-origin saves and keeps operation status and source private", async () => {
    const { op, input } = await codeEdit();
    const { POST, GET } =
      await import("../apps/web/src/app/api/projects/[[...path]]/route");
    const response = await POST(
      new Request(`https://app.test/api/projects/${a}/operations`, {
        method: "POST",
        headers: {
          origin: "https://evil.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ path: [a, "operations"] }) },
    );
    expect(response.status).toBe(403);
    const read = () =>
      GET(
        new Request(`https://app.test/api/projects/${a}/operations/${op.id}`),
        { params: Promise.resolve({ path: [a, "operations", op.id] }) },
      );
    expect(await (await read()).json()).toEqual({
      id: op.id,
      status: "queued",
      error: null,
      version: null,
    });
    mocks.user = "user_b";
    expect((await read()).status).toBe(404);
  });
  function detached(output = "hello\n", exitCode = 0) {
    return {
      wait: async () => ({ exitCode }),
      logs: async function* () {
        yield { data: output, stream: "stdout" };
      },
    };
  }
  async function terminalFixture() {
    const v = await version();
    const t = await admitTerminal("user_a", a, crypto.randomUUID(), v.id);
    await prepareTerminal(t.id);
    mocks.sandbox.runCommand.mockImplementation(async ({ cmd }) => ({
      exitCode: cmd === "pgrep" ? 1 : 0,
    }));
    return { t, v };
  }
  async function commandFor(t: { id: string }, command = "ls") {
    return admitTerminalCommand(
      "user_a",
      a,
      t.id,
      crypto.randomUUID(),
      command,
    );
  }
  it("isolates terminal setup from saved code, credentials, preview ports and network", async () => {
    const { t, v } = await terminalFixture();
    const { Sandbox } = await import("@vercel/sandbox");
    expect(Sandbox.getOrCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: `eveable-terminal-${t.id}`,
        ports: [],
        persistent: false,
        networkPolicy: { allow: ["registry.npmjs.org"] },
        env: { CI: "true", NEXT_TELEMETRY_DISABLED: "1" },
      }),
    );
    expect(mocks.sandbox.createUser).toHaveBeenCalledWith(
      "runner",
      expect.anything(),
    );
    expect(mocks.runner.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "env",
        args: expect.arrayContaining([
          "-i",
          "npm",
          "install",
          "--ignore-scripts",
        ]),
        cwd: "/home/runner/generated-app",
        detached: true,
      }),
    );
    expect(mocks.sandbox.updateNetworkPolicy).toHaveBeenCalledWith(
      "deny-all",
      expect.anything(),
    );
    expect((await terminalState("user_a", a)).terminal?.status).toBe("ready");
    expect((await requireProject("user_a", a)).currentVersionId).toBe(v.id);
    expect(await database().select().from(previews)).toHaveLength(0);
  });
  it("serializes terminal starts and commands and rejects changed idempotent requests", async () => {
    const v = await version();
    const key = crypto.randomUUID();
    const [one, two] = await Promise.all([
      admitTerminal("user_a", a, key, v.id),
      admitTerminal("user_a", a, key, v.id),
    ]);
    expect(one.id).toBe(two.id);
    await expect(
      admitTerminal("user_a", a, key, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "key_reused" });
    await expect(
      admitTerminal("user_a", a, crypto.randomUUID(), v.id),
    ).rejects.toMatchObject({ code: "terminal_busy" });
    await prepareTerminal(one.id);
    const commandKey = crypto.randomUUID();
    const [c1, c2] = await Promise.all([
      admitTerminalCommand("user_a", a, one.id, commandKey, "ls"),
      admitTerminalCommand("user_a", a, one.id, commandKey, "ls"),
    ]);
    expect(c1.id).toBe(c2.id);
    await expect(
      admitTerminalCommand("user_a", a, one.id, commandKey, "pwd"),
    ).rejects.toMatchObject({ code: "key_reused" });
    await expect(commandFor(one, "pwd")).rejects.toMatchObject({
      code: "terminal_busy",
    });
    expect((await terminalState("user_a", a)).terminal?.commandCount).toBe(1);
  });
  it("rejects foreign, stale, busy, archived and expired terminal admission", async () => {
    const { t, v } = await terminalFixture();
    await expect(
      admitTerminal("user_b", a, crypto.randomUUID(), v.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      admitTerminal("user_a", a, crypto.randomUUID(), crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "version_changed" });
    await expect(
      admitTerminalCommand("user_b", b, t.id, crypto.randomUUID(), "ls"),
    ).rejects.toMatchObject({ status: 404 });
    await database()
      .update(terminals)
      .set({ expiresAt: new Date(0) })
      .where(eq(terminals.id, t.id));
    await expect(commandFor(t)).rejects.toMatchObject({
      code: "terminal_expired",
    });
    await stopTerminal(t.id);
    await database()
      .update(projects)
      .set({ archived: true })
      .where(eq(projects.id, a));
    await expect(
      admitTerminal("user_a", a, crypto.randomUUID(), v.id),
    ).rejects.toMatchObject({ code: "busy" });
  });
  it("enforces durable terminal session and daily limits", async () => {
    const { t, v } = await terminalFixture();
    await database()
      .update(terminals)
      .set({ commandCount: 20 })
      .where(eq(terminals.id, t.id));
    await expect(commandFor(t)).rejects.toMatchObject({ status: 429 });
    await stopTerminal(t.id);
    await database()
      .insert(terminals)
      .values(
        Array.from({ length: 9 }, () => ({
          ownerId: "user_a",
          projectId: a,
          versionId: v.id,
          key: crypto.randomUUID(),
          expiresAt: new Date(),
          status: "closed",
        })),
      );
    await expect(
      admitTerminal("user_a", a, crypto.randomUUID(), v.id),
    ).rejects.toMatchObject({ status: 429 });
  });
  it.each([0, 2])(
    "streams sanitized output and reports exit %s without changing saved source",
    async (exitCode) => {
      const { t, v } = await terminalFixture();
      const entry = await commandFor(t, "printf hello");
      mocks.runner.runCommand.mockResolvedValue(
        detached("hello\nTOKEN=secret-value\n", exitCode),
      );
      await executeTerminalCommand(entry.id);
      const state = await terminalState("user_a", a);
      expect(state.commands[0]).toMatchObject({
        status: exitCode ? "failed" : "completed",
        exitCode,
        output: "hello\nTOKEN=[redacted]\n",
      });
      expect(state.terminal).toMatchObject({ busy: false, status: "ready" });
      expect(mocks.sandbox.runCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: "pkill",
          sudo: true,
          args: ["-KILL", "-u", "runner"],
        }),
      );
      expect(JSON.stringify(state)).not.toMatch(
        /sandboxName|workflowId|ownerId|idempotency/,
      );
      expect((await requireProject("user_a", a)).currentVersionId).toBe(v.id);
      const calls = mocks.runner.runCommand.mock.calls.length;
      await executeTerminalCommand(entry.id);
      expect(mocks.runner.runCommand).toHaveBeenCalledTimes(calls);
    },
  );
  it.each(["output", "timeout", "cleanup"])(
    "terminates unsafe execution on %s",
    async (failure) => {
      const { t } = await terminalFixture();
      const entry = await commandFor(t);
      mocks.runner.runCommand.mockResolvedValue(
        detached(
          failure === "output" ? "x".repeat(65000) : "hello",
          failure === "timeout" ? 137 : 0,
        ),
      );
      if (failure === "cleanup")
        mocks.sandbox.runCommand.mockResolvedValue({ exitCode: 2 });
      await executeTerminalCommand(entry.id);
      const state = await terminalState("user_a", a);
      expect(state.terminal?.status).toBe("failed");
      expect(state.commands[0].status).toBe(
        failure === "output"
          ? "output_limit"
          : failure === "timeout"
            ? "timed_out"
            : "failed",
      );
      expect(Buffer.byteLength(state.commands[0].output)).toBeLessThanOrEqual(
        64000,
      );
      expect(mocks.sandbox.stop).toHaveBeenCalled();
    },
  );
  it("never replays uncertain commands or dispatches a command cancelled before execution", async () => {
    const { t } = await terminalFixture();
    const entry = await commandFor(t);
    await database()
      .update(terminalCommands)
      .set({ status: "running" })
      .where(eq(terminalCommands.id, entry.id));
    mocks.runner.runCommand.mockClear();
    await executeTerminalCommand(entry.id);
    expect(mocks.runner.runCommand).not.toHaveBeenCalled();
    expect((await terminalState("user_a", a)).terminal?.status).toBe("failed");
    const t2 = await admitTerminal(
      "user_a",
      a,
      crypto.randomUUID(),
      t.versionId,
    );
    await prepareTerminal(t2.id);
    const c2 = await commandFor(t2);
    await stopTerminal(t2.id);
    mocks.runner.runCommand.mockClear();
    await executeTerminalCommand(c2.id);
    expect(mocks.runner.runCommand).not.toHaveBeenCalled();
  });
  it("retains the account slot when Stop is uncertain and allows a cleanup retry", async () => {
    const { t, v } = await terminalFixture();
    await commandFor(t);
    mocks.sandbox.stop.mockRejectedValueOnce(
      new Error("provider transport lost"),
    );
    await stopTerminal(t.id);
    expect((await terminalState("user_a", a)).terminal).toMatchObject({
      status: "cleanup_required",
      busy: true,
    });
    await expect(
      admitTerminal("user_a", a, crypto.randomUUID(), v.id),
    ).rejects.toMatchObject({ code: "terminal_busy" });
    await stopTerminal(t.id);
    expect((await terminalState("user_a", a)).terminal).toMatchObject({
      status: "closed",
      busy: false,
    });
    await expect(
      admitTerminal("user_a", a, crypto.randomUUID(), v.id),
    ).resolves.toBeDefined();
  });
  it("checks revocation immediately before dispatch and during a running command", async () => {
    const { t } = await terminalFixture();
    const entry = await commandFor(t);
    // Revoke outside dispatch's membership lock, while execution is in flight.
    mocks.runner.runCommand.mockResolvedValue({
      wait: () => new Promise(() => {}),
      logs: async function* () {
        await database()
          .update(members)
          .set({ active: false })
          .where(eq(members.userId, "user_a"));
        yield { data: "waiting\n" };
      },
    });
    await executeTerminalCommand(entry.id);
    expect(mocks.sandbox.stop).toHaveBeenCalled();
    expect(
      (
        await database().query.terminals.findFirst({
          where: eq(terminals.id, t.id),
        })
      )?.status,
    ).toBe("failed");
  });
  it("enforces terminal browser origin, ownership, dispatch idempotency and safe output DTOs", async () => {
    const v = await version();
    const route =
      await import("../apps/web/src/app/api/projects/[[...path]]/route");
    const { start } =
      await import("../apps/web/node_modules/workflow/dist/api.js");
    vi.mocked(start).mockClear();
    const path = [a, "terminals"];
    const key = crypto.randomUUID();
    const post = (origin = "https://app.test") =>
      route.POST(
        new Request("https://app.test/api/projects/" + path.join("/"), {
          method: "POST",
          headers: { origin, "idempotency-key": key },
          body: JSON.stringify({ versionId: v.id }),
        }),
        { params: Promise.resolve({ path }) },
      );
    expect((await post("https://evil.test")).status).toBe(403);
    mocks.user = "user_b";
    expect((await post()).status).toBe(404);
    mocks.user = "user_a";
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
    const response = await route.GET(
      new Request("https://app.test/api/projects/" + path.join("/")),
      { params: Promise.resolve({ path }) },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/sandboxName|workflowId|ownerId/);
  });
  it("serializes concurrent Stop calls without resuming an already closed sandbox", async () => {
    const { t } = await terminalFixture();
    const { Sandbox } = await import("@vercel/sandbox");
    vi.mocked(Sandbox.get).mockClear();
    await Promise.all([stopTerminal(t.id), stopTerminal(t.id)]);
    expect(Sandbox.get).toHaveBeenCalledTimes(1);
    expect(mocks.sandbox.stop).toHaveBeenCalledTimes(1);
    expect((await terminalState("user_a", a)).terminal?.status).toBe("closed");
  });
  it("does not resume provider execution for late process cleanup after Stop", async () => {
    const { t } = await terminalFixture();
    const entry = await commandFor(t);
    let complete!: (value: { exitCode: number }) => void;
    const result = new Promise<{ exitCode: number }>((resolve) => {
      complete = resolve;
    });
    mocks.runner.runCommand.mockClear().mockResolvedValue({
      wait: () => result,
      logs: async function* () {
        yield { data: "running\n" };
      },
    });
    const execution = executeTerminalCommand(entry.id);
    await vi.waitFor(() =>
      expect(mocks.runner.runCommand).toHaveBeenCalledTimes(1),
    );
    await stopTerminal(t.id);
    complete({ exitCode: 0 });
    await execution;
    expect(mocks.sandbox.runCommand).not.toHaveBeenCalled();
    expect((await terminalState("user_a", a)).commands[0].status).toBe(
      "cancelled",
    );
  });
  it("does not dispatch after revocation between admission and worker execution", async () => {
    const { t } = await terminalFixture();
    const entry = await commandFor(t);
    await database()
      .update(members)
      .set({ active: false })
      .where(eq(members.userId, "user_a"));
    mocks.runner.runCommand.mockClear();
    await executeTerminalCommand(entry.id);
    expect(mocks.runner.runCommand).not.toHaveBeenCalled();
    expect(mocks.sandbox.stop).toHaveBeenCalled();
  });
  it("never redispatches a command whose Workflow start response was lost", async () => {
    const { t } = await terminalFixture();
    const { POST } =
      await import("../apps/web/src/app/api/projects/[[...path]]/route");
    const { start } =
      await import("../apps/web/node_modules/workflow/dist/api.js");
    vi.mocked(start)
      .mockClear()
      .mockRejectedValueOnce(new Error("lost response"));
    const path = [a, "terminals", t.id, "commands"];
    const key = crypto.randomUUID();
    const request = () =>
      POST(
        new Request("https://app.test/api/projects/" + path.join("/"), {
          method: "POST",
          headers: { origin: "https://app.test", "idempotency-key": key },
          body: JSON.stringify({ command: "ls" }),
        }),
        { params: Promise.resolve({ path }) },
      );
    expect((await request()).status).toBe(503);
    expect((await request()).status).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
    const state = await terminalState("user_a", a);
    expect(state.commands).toHaveLength(1);
    expect(state.terminal?.busy).toBe(true);
    expect(state.commands[0].error).toContain("could not be confirmed");
  });
});
