import { stripVTControlCharacters } from "node:util";
import { AppError } from "@eveable/core/errors";

export const terminalLimits = {
  lifetimeMs: 15 * 60_000,
  commandMs: 120_000,
  outputBytes: 64_000,
  commands: 20,
  dailyStarts: 10,
} as const;
export const terminalWorkspace = "/home/runner/generated-app";

export function cleanTerminalText(value: string) {
  let text = stripVTControlCharacters(value).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
  for (const [name, secret] of Object.entries(process.env)) {
    if (
      /(SECRET|TOKEN|API_KEY|DATABASE_URL)/.test(name) &&
      secret &&
      secret.length >= 8
    )
      text = text.split(secret).join("[redacted]");
  }
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted private key]",
    )
    .replace(
      /\b(?:sk_live_|sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]*/g,
      "[redacted]",
    )
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(
      /((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\r\n]+/gi,
      "$1[redacted]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

export function terminalCommand(value: string) {
  const command = value.trim();
  if (
    !command ||
    command.length > 4000 ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(command)
  )
    throw new AppError(
      400,
      "invalid_command",
      "Enter a command of up to 4,000 characters.",
    );
  if (cleanTerminalText(command) !== command)
    throw new AppError(
      400,
      "terminal_secret",
      "Do not enter credentials in terminal commands.",
    );
  return command;
}

// Keep incomplete lines server-side so credentials split across provider chunks
// cannot leak through an earlier output update. Never retain more than the cap.
export class TerminalOutput {
  private raw = "";
  private bytes = 0;
  append(value: string) {
    const chunk = Buffer.from(value);
    const remaining = Math.max(0, terminalLimits.outputBytes - this.bytes);
    this.raw += chunk.subarray(0, remaining).toString("utf8");
    this.bytes += chunk.length;
    return this.bytes > terminalLimits.outputBytes;
  }
  text(final = false) {
    const text = final
      ? this.raw
      : this.raw.slice(0, this.raw.lastIndexOf("\n") + 1);
    return new TextDecoder().decode(
      Buffer.from(cleanTerminalText(text)).subarray(
        0,
        terminalLimits.outputBytes,
      ),
      { stream: true },
    );
  }
}
