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
test("source is read-only and restore requires a dialog", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "mobile")
    await page.getByRole("tab", { name: "Versions", exact: true }).click();
  else
    await page.getByRole("button", { name: "Versions", exact: true }).click();
  await page.getByRole("button", { name: "View source" }).first().click();
  await expect(page.locator("pre")).toContainText("export default");
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
