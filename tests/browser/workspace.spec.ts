import { test, expect } from "@playwright/test";
const id = "00000000-0000-4000-8000-000000000001",
  version = "00000000-0000-4000-8000-000000000002";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/projects**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/projects/${id}/stream`)
      return route.fulfill({
        contentType: "application/x-ndjson",
        body:
          JSON.stringify({
            id: "user",
            cursor: 1,
            kind: "user",
            data: { text: "Build a website for a small architecture studio." },
            createdAt: new Date().toISOString(),
          }) + "\n",
      });
    if (url.pathname === `/api/projects/${id}/versions/${version}`)
      return route.fulfill({
        json: {
          files: [
            {
              path: "app/page.tsx",
              content:
                "export default function Page() { return <main>Studio</main>; }",
            },
          ],
        },
      });
    if (route.request().method() === "POST")
      return route.fulfill({ json: { id, status: "queued" } });
    if (url.pathname === "/api/projects")
      return route.fulfill({
        json: [
          {
            id,
            name: "Fieldwork Architecture",
            status: "awaiting_approval",
            archived: false,
            updatedAt: new Date().toISOString(),
            currentVersionId: version,
          },
        ],
      });
    return route.fulfill({
      json: {
        project: {
          id,
          name: "Fieldwork Architecture",
          status: "awaiting_approval",
          archived: false,
          currentVersionId: version,
          publishedVersionId: null,
          deploymentUrl: null,
          busy: false,
        },
        versions: [
          {
            id: version,
            hash: "a".repeat(64),
            summary: "First direction — editorial layout",
            manifest: ["app/page.tsx"],
            createdAt: "2026-09-22T12:00:00Z",
            baseVersionId: null,
          },
        ],
        pending: [
          {
            requestId: "approval-1",
            prompt:
              "A quiet editorial site with a large project gallery, generous space, and a concise studio introduction.",
            options: [
              { id: "build", label: "Approve and build" },
              { id: "revise", label: "Revise design" },
              { id: "stop", label: "Stop" },
            ],
          },
        ],
        preview: null,
        release: null,
        error: null,
      },
    });
  });
});
test("approval is explicit, revision needs notes, and the layout fits the viewport", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile")
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Does this feel right?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revise design", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Revision notes")
    .fill("Keep the gallery; use larger titles.");
  const outgoing = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/operations"),
  );
  await page
    .getByRole("button", { name: "Revise design", exact: true })
    .click();
  expect((await outgoing).postDataJSON()).toEqual({
    kind: "approval",
    requestId: "approval-1",
    optionId: "revise",
    notes: "Keep the gallery; use larger titles.",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/workspace-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("code is locked during approval and restore requires a dialog", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile")
    await page.getByRole("tab", { name: "Versions", exact: true }).click();
  else
    await page.getByRole("button", { name: "Versions", exact: true }).click();
  await page.getByRole("button", { name: "View source" }).first().click();
  await expect(
    page.getByRole("textbox", { name: "Code for app/page.tsx" }),
  ).toContainText("export default");
  await expect(
    page.getByRole("button", { name: "Save & Preview" }),
  ).toBeDisabled();
  if (testInfo.project.name === "mobile")
    await page.getByRole("tab", { name: "Versions", exact: true }).click();
  else
    await page.getByRole("button", { name: "Versions", exact: true }).click();
  await page
    .getByRole("button", { name: "Restore", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Your published site will stay unchanged.",
  );
  await page.getByRole("button", { name: "Keep working" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
test("project home supports search and real empty states", async ({
  page,
}, testInfo) => {
  await page.goto("/?home");
  await expect(
    page.getByText("Fieldwork Architecture", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search projects").fill("unmatched");
  await expect(page.getByText("No projects match your search.")).toBeVisible();
  await page.getByLabel("Search projects").fill("");
  await page.screenshot({
    path: `test-results/home-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

async function editorFixture(page: import("@playwright/test").Page) {
  const nextVersion = "00000000-0000-4000-8000-000000000003";
  let op = "00000000-0000-4000-8000-000000000004";
  const base = {
    id: version,
    hash: "a".repeat(64),
    summary: "First version",
    manifest: ["app/page.tsx", "app/globals.css"],
    createdAt: "2026-09-22T12:00:00Z",
    baseVersionId: null,
  };
  const next = {
    ...base,
    id: nextVersion,
    hash: "b".repeat(64),
    summary: "Manual code changes",
    baseVersionId: version,
  };
  const fixture = {
    status: "idle",
    current: version,
    error: null as string | null,
    submitted: [] as {
      body: Record<string, unknown>;
      key: string | undefined;
    }[],
  };
  await page.route(`**/api/projects/${id}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stream"))
      return route.fulfill({ contentType: "application/x-ndjson", body: "" });
    if (url.pathname.includes("/versions/"))
      return route.fulfill({
        json: {
          files: [
            {
              path: "app/page.tsx",
              content:
                "export default function Page() { return <main>Studio</main>; }",
            },
            { path: "app/globals.css", content: "main { color: green; }" },
          ],
        },
      });
    if (/\/operations\/[^/]+$/.test(url.pathname))
      return route.fulfill({
        json: {
          status: fixture.status,
          error: fixture.error,
          version: fixture.status === "completed" ? next : null,
        },
      });
    if (route.request().method() === "POST") {
      fixture.submitted.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"],
      });
      op = `00000000-0000-4000-8000-${String(fixture.submitted.length + 4).padStart(12, "0")}`;
      fixture.status = "queued";
      return route.fulfill({ json: { id: op, status: "queued" } });
    }
    return route.fulfill({
      json: {
        project: {
          id,
          name: "Fieldwork Architecture",
          status: "preview_available",
          currentVersionId: fixture.current,
          publishedVersionId: null,
          deploymentUrl: null,
          busy: fixture.status === "queued",
          archived: false,
        },
        versions: fixture.current === nextVersion ? [next, base] : [base],
        pending: [],
        preview: null,
        release: null,
        error: fixture.error,
      },
    });
  });
  return { fixture, nextVersion };
}
test("editor preserves drafts, undo and preview state across tabs and files", async ({
  page,
}, testInfo) => {
  await editorFixture(page);
  await page.goto("/");
  const preview = await page
    .locator('iframe[title="Generated application preview"]')
    .elementHandle();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Code for app/page.tsx" });
  await editor.fill(
    "export default function Page() { return <main>Edited studio</main>; }",
  );
  await expect(page.getByText("1 file changed", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "app/globals.css", exact: true })
    .click();
  await page.getByRole("button", { name: "app/page.tsx" }).click();
  await expect(editor).toContainText("Edited studio");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  expect(
    await preview!.evaluate(
      (el) =>
        el ===
        document.querySelector('iframe[title="Generated application preview"]'),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(editor).toContainText("Edited studio");
  await editor.press("ControlOrMeta+z");
  await expect(editor).toContainText("<main>Studio</main>");
  await expect(
    page.getByRole("button", { name: "Save & Preview" }),
  ).toBeDisabled();
  await editor.fill(
    "export default function Page() { return <main>Edited studio</main>; }",
  );
  await editor.press("ControlOrMeta+f");
  await expect(page.getByPlaceholder("Find")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/code-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("Save & Preview sends only changes, retains failed drafts, and opens the checked version", async ({
  page,
}) => {
  const { fixture, nextVersion } = await editorFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Code for app/page.tsx" });
  const edited =
    "export default function Page() { return <main>Edited</main>; }";
  await editor.fill(edited);
  await page.getByRole("button", { name: "Save & Preview" }).click();
  await expect(
    page.getByRole("button", { name: "Checking changes…" }),
  ).toBeDisabled();
  expect(fixture.submitted[0].body).toEqual({
    kind: "code_edit",
    versionId: version,
    hash: "a".repeat(64),
    files: [{ path: "app/page.tsx", content: edited }],
  });
  expect(fixture.submitted[0].key).toBeTruthy();
  fixture.status = "failed";
  fixture.error = "Checking TypeScript failed.";
  await expect(
    page
      .locator(".code-panel")
      .getByRole("alert")
      .filter({ hasText: "Checking TypeScript failed." }),
  ).toBeVisible();
  await expect(editor).toContainText("Edited");
  await page.getByRole("button", { name: "Save & Preview" }).click();
  expect(fixture.submitted[1].key).not.toBe(fixture.submitted[0].key);
  fixture.current = nextVersion;
  fixture.status = "completed";
  fixture.error = null;
  await expect(page.locator(".preview-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await expect(editor).toContainText("Edited");
});
test("a newer version preserves the draft and prevents a stale save", async ({
  page,
}) => {
  const { fixture, nextVersion } = await editorFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Code for app/page.tsx" });
  await editor.fill("draft from this tab");
  fixture.current = nextVersion;
  await expect(page.getByText(/A newer version was saved/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save & Preview" }),
  ).toBeDisabled();
  await expect(editor).toContainText("draft from this tab");
  await page.getByRole("button", { name: "Open latest code" }).click();
  await expect(editor).toContainText("Studio");
});

async function terminalFixture(page: import("@playwright/test").Page) {
  await editorFixture(page);
  const terminalId = "00000000-0000-4000-8000-000000000009";
  const fixture = {
    terminal: null as null | {
      id: string;
      versionId: string;
      status: string;
      expiresAt: string;
      commandCount: number;
      busy: boolean;
      error: string | null;
    },
    commands: [] as {
      id: string;
      command: string;
      status: string;
      output: string;
      exitCode: number | null;
      error: string | null;
      createdAt: string;
    }[],
    requests: [] as {
      path: string;
      body: Record<string, unknown>;
      key: string | undefined;
    }[],
    failNext: false,
  };
  await page.route(`**/api/projects/${id}/terminals**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { terminal: fixture.terminal, commands: fixture.commands },
      });
    fixture.requests.push({
      path,
      body: route.request().postDataJSON(),
      key: route.request().headers()["idempotency-key"],
    });
    if (fixture.failNext) {
      fixture.failNext = false;
      return route.fulfill({
        status: 503,
        json: { error: "Connection lost. Try again." },
      });
    }
    if (path.endsWith("/stop")) {
      fixture.terminal!.status = "closed";
      fixture.terminal!.busy = false;
      return route.fulfill({
        json: { terminal: fixture.terminal, commands: fixture.commands },
      });
    }
    if (path.endsWith("/commands")) {
      fixture.terminal!.busy = true;
      fixture.terminal!.commandCount++;
      fixture.commands.push({
        id: crypto.randomUUID(),
        command: String(route.request().postDataJSON().command),
        status: "running",
        output: "",
        exitCode: null,
        error: null,
        createdAt: new Date().toISOString(),
      });
      return route.fulfill({ json: { id: fixture.commands.at(-1)!.id } });
    }
    fixture.terminal = {
      id: terminalId,
      versionId: version,
      status: "ready",
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      commandCount: 0,
      busy: false,
      error: null,
    };
    return route.fulfill({ json: { id: terminalId } });
  });
  return fixture;
}

test("terminal preserves editor drafts and input, runs commands, and stops cleanly", async ({
  page,
}, testInfo) => {
  const fixture = await terminalFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Code for app/page.tsx" });
  await editor.fill("unsaved editor draft");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByText("A place to inspect and test.")).toBeVisible();
  await page
    .getByRole("button", { name: "Start terminal", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop terminal" }),
  ).toBeVisible();
  expect(fixture.requests[0].body).toEqual({ versionId: version });
  const input = page.getByRole("textbox", { name: "Terminal command" });
  await input.fill("npm run typecheck");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect(editor).toContainText("unsaved editor draft");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(input).toHaveValue("npm run typecheck");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Run", exact: true }),
  ).toBeDisabled();
  fixture.commands[0].output =
    "> tsc --noEmit\n\nNo errors found.\n<script>window.terminalInjected=true</script>";
  fixture.commands[0].exitCode = 0;
  fixture.commands[0].status = "completed";
  fixture.terminal!.busy = false;
  await expect(
    page.getByText("Exited with code 0", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => "terminalInjected" in window)).toBe(false);
  await page
    .getByRole("button", { name: "Reuse command: npm run typecheck" })
    .click();
  await expect(input).toHaveValue("npm run typecheck");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/terminal-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Stop terminal" }).click();
  await expect(
    page.getByRole("button", { name: "Start fresh terminal" }),
  ).toBeVisible();
});

test("terminal retry retains the exact request and input; expiry prevents commands", async ({
  page,
}) => {
  const fixture = await terminalFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("button", { name: "Start terminal", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop terminal" }),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "Terminal command" });
  await input.fill("ls");
  fixture.failNext = true;
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Connection lost");
  await expect(input).toHaveValue("ls");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(input).toHaveValue("");
  expect(fixture.requests[1].key).toBe(fixture.requests[2].key);
  fixture.terminal!.busy = false;
  fixture.terminal!.expiresAt = new Date(0).toISOString();
  await input.fill("pwd");
  await expect(page.locator(".terminal-header")).toContainText("Expired");
  await expect(
    page.getByRole("button", { name: "Run", exact: true }),
  ).toBeDisabled();
  fixture.terminal!.status = "cleanup_required";
  fixture.terminal!.error = "Stopping could not be confirmed.";
  await expect(page.getByRole("button", { name: "Retry Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Retry Stop" }).click();
  await expect(
    page.getByRole("button", { name: "Start fresh terminal" }),
  ).toBeVisible();
});
