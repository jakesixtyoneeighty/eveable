import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSource } from "@eveable/core/artifacts";
import { sourceHashProgram } from "@eveable/core/code-edit";
import { body } from "../apps/web/src/lib/http";

describe("manual code verification", () => {
  it("reads the actual source bytes and refuses symlinks", () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "eveable-code-test-")),
    );
    try {
      const file = {
        path: "page.tsx",
        content: "export default function Page(){ return <p>Hello</p> }",
      };
      writeFileSync(join(directory, file.path), file.content);
      const program = sourceHashProgram.replace(
        "/vercel/sandbox/app",
        directory,
      );
      const hash = () =>
        execFileSync(process.execPath, ["-e", program, "--", file.path], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      expect(hash()).toBe(canonicalSource([file]).hash);
      writeFileSync(join(directory, file.path), "modified during build");
      expect(hash()).not.toBe(canonicalSource([file]).hash);
      rmSync(join(directory, file.path));
      writeFileSync(join(directory, "target.tsx"), file.content);
      symlinkSync(join(directory, "target.tsx"), join(directory, file.path));
      expect(hash).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("bounds request bytes as they stream in, including multibyte content", async () => {
    const request = new Request("https://app.test", {
      method: "POST",
      body: JSON.stringify({ content: "é".repeat(15000) }),
    });
    await expect(body(request)).rejects.toMatchObject({ status: 413 });
    await expect(
      body(
        new Request("https://app.test", {
          method: "POST",
          body: JSON.stringify({ content: "é".repeat(15000) }),
        }),
        3_000_000,
      ),
    ).resolves.toEqual({ content: "é".repeat(15000) });
    await expect(
      body(new Request("https://app.test", { method: "POST", body: "{" })),
    ).rejects.toMatchObject({ code: "invalid_json" });
  });
});
