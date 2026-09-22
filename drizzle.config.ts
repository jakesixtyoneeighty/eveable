import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/core/src/schema.ts",
  out: "./packages/core/migrations",
});
