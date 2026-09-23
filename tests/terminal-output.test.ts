import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanTerminalText,
  terminalCommand,
  terminalLimits,
  TerminalOutput,
} from "@eveable/core/terminal-output";
afterEach(() => vi.unstubAllEnvs());
describe("terminal command and output boundaries", () => {
  it("accepts shell syntax but refuses credentials and control sequences", () => {
    expect(terminalCommand("  ls && printf hello  ")).toBe(
      "ls && printf hello",
    );
    for (const value of [
      "",
      "x".repeat(4001),
      "ls\x00",
      "echo \x1b[31m",
      "curl -H 'Authorization: Bearer abc123'",
      "TOKEN=private-value node app.js",
    ])
      expect(() => terminalCommand(value)).toThrow();
  });
  it("holds incomplete chunks until secrets can be redacted together", () => {
    vi.stubEnv("TERMINAL_TEST_API_KEY", "server-secret-abcdef");
    const output = new TerminalOutput();
    output.append("hello\nserver-secret-");
    expect(output.text()).toBe("hello\n");
    output.append("abcdef\n\x1b[31mred\x1b[0m\nBearer abc");
    expect(output.text()).toBe("hello\n[redacted]\nred\n");
    output.append("def\n");
    expect(output.text(true)).toBe(
      "hello\n[redacted]\nred\nBearer [redacted]\n",
    );
  });
  it("removes control codes, credential URLs and private keys", () => {
    expect(
      cleanTerminalText("\x1b]8;;https://bad.test\x07click\x1b]8;;\x07\x00"),
    ).toBe("click");
    expect(cleanTerminalText("postgres://user:pass@db.test/a")).toBe(
      "postgres://[redacted]@db.test/a",
    );
    expect(
      cleanTerminalText(
        "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
      ),
    ).not.toContain("private\n");
  });
  it("caps multibyte and repeated overflow output without retaining extra bytes", () => {
    const output = new TerminalOutput();
    expect(output.append("é".repeat(40000))).toBe(true);
    const full = output.text(true);
    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(
      terminalLimits.outputBytes,
    );
    expect(output.append("more output")).toBe(true);
    expect(output.text(true)).toBe(full);
    expect(full).not.toContain("�");
  });
});
