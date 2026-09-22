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
} from "@eveable/core/schema";
import { requireMember, requireProject } from "@eveable/core/access";
import { admitOperation, finishOperation } from "@eveable/core/operations";
import { persistEvent } from "@eveable/core/projection";
import { canonicalSource } from "@eveable/core/artifacts";
const mocks = vi.hoisted(() => ({
  source: "",
  sandbox: {
    runCommand: vi.fn(),
    writeFiles: vi.fn(),
    stop: vi.fn(),
    status: "running",
  },
  user: "user_a",
}));
vi.mock("@vercel/blob", () => ({
  get: vi.fn(async () => ({
    statusCode: 200,
    stream: new Response(mocks.source).body,
  })),
  put: vi.fn(async (path: string) => ({ pathname: path })),
}));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    getOrCreate: vi.fn(async () => mocks.sandbox),
    get: vi.fn(async () => mocks.sandbox),
  },
}));
vi.mock("workflow/api", () => ({
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
      sql`truncate deployments, previews, versions, activity, project_sessions, operations, projects, members restart identity cascade`,
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
    mocks.sandbox.stop.mockReset().mockResolvedValue(undefined);
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
});
