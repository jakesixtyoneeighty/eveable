import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@/": new URL("./apps/web/src/", import.meta.url).pathname },
  },
});
