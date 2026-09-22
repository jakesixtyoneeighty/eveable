import { test, expect } from "@playwright/test";
test.skip(
  !process.env.E2E_BASE_URL ||
    !process.env.E2E_STORAGE_STATE ||
    process.env.E2E_LIVE_BUILD !== "true",
  "Hosted acceptance requires explicit staging credentials and live-build opt-in.",
);
test.use({ storageState: process.env.E2E_STORAGE_STATE });
test("hosted sign-in, approval, version capture, reconnect, and isolated preview", async ({
  page,
}) => {
  test.setTimeout(600000);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Make room/ })).toBeVisible();
  await page
    .getByLabel("Describe your project")
    .fill(
      "Build a minimal one-page website for a fictional architectural studio named Acceptance Studio. Include a heading, short introduction and projects section. No forms or external integrations.",
    );
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects\//);
  await expect(
    page.getByRole("button", { name: "Approve and build", exact: true }),
  ).toBeVisible({ timeout: 180000 });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Approve and build", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Approve and build", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start preview", exact: true }),
  ).toBeEnabled({ timeout: 300000 });
  await page
    .getByRole("button", { name: "Start preview", exact: true })
    .click();
  await expect(page.frameLocator("iframe").locator("body")).toContainText(
    /Acceptance|Studio/,
    { timeout: 180000 },
  );
  const frame = page.locator("iframe");
  expect(await frame.getAttribute("sandbox")).not.toContain(
    "allow-top-navigation",
  );
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.locator("pre")).toContainText(/./);
  if (process.env.E2E_ALLOW_PUBLISH === "true") {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page
      .getByRole("button", { name: "Publish publicly", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "View published site" }),
    ).toBeVisible({ timeout: 180000 });
  }
});
