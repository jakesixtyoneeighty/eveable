import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: process.env.E2E_BASE_URL ? "live.spec.ts" : "workspace.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3107",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    ...(process.env.E2E_BASE_URL
      ? []
      : [
          {
            name: "mobile",
            use: {
              ...devices["iPhone 13"],
              defaultBrowserType: "chromium" as const,
            },
          },
        ]),
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm exec vite --config tests/ui/vite.config.ts",
        url: "http://127.0.0.1:3107",
        reuseExistingServer: !process.env.CI,
      },
});
