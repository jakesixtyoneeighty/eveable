import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const path = (s: string) => fileURLToPath(new URL(s, import.meta.url));
export default defineConfig({
  root: path("."),
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: "@", replacement: path("../../apps/web/src") },
      { find: "next/link", replacement: path("./next-link.tsx") },
      { find: "next/navigation", replacement: path("./navigation.ts") },
      { find: "@clerk/nextjs", replacement: path("./clerk.tsx") },
    ],
  },
  server: { host: "127.0.0.1", port: 3107, fs: { allow: [path("../..")] } },
  esbuild: { jsx: "automatic" },
});
