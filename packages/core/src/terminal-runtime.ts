import { Sandbox, type Command } from "@vercel/sandbox";
import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import { terminals, terminalCommands, versions } from "@eveable/core/schema";
import { readArtifact } from "@eveable/core/artifacts";
import { requireProject } from "@eveable/core/access";
import { AppError } from "@eveable/core/errors";
import {
  authorizeTerminal,
  stopTerminal,
  withTerminalLock,
} from "@eveable/core/terminal";
import {
  TerminalOutput,
  terminalLimits,
  terminalWorkspace,
} from "@eveable/core/terminal-output";

const signal = () => AbortSignal.timeout(20000);
const environment = [
  "-i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/home/runner",
  "CI=true",
  "NEXT_TELEMETRY_DISABLED=1",
  "TERM=dumb",
];
async function shutdown(
  id: string,
  sandbox: Sandbox | undefined,
  reason: string,
  commandStatus = "failed",
) {
  try {
    await stopTerminal(id, reason, "failed", commandStatus, sandbox);
  } catch (error) {
    // A database outage must never prevent terminating provider execution.
    await sandbox?.stop({ signal: signal() }).catch(() => undefined);
    throw error;
  }
}

export async function prepareTerminal(id: string) {
  let sandbox: Sandbox | undefined;
  try {
    const claimed = await withTerminalLock(id, async (tx, t) => {
      if (
        [
          "closed",
          "failed",
          "expired",
          "cleanup_required",
          "stopping",
        ].includes(t.status)
      )
        return null;
      await authorizeTerminal(tx, t);
      if (t.status === "ready") return { ...t, replay: true };
      if (t.status !== "queued")
        throw new Error("Interrupted terminal initialization.");
      const name = `eveable-terminal-${id}`;
      await tx
        .update(terminals)
        .set({ status: "starting", sandboxName: name })
        .where(eq(terminals.id, id));
      return { ...t, sandboxName: name, replay: false };
    });
    if (!claimed) return null;
    if (claimed.replay) return claimed.expiresAt.toISOString();
    const version = await database().query.versions.findFirst({
      where: and(
        eq(versions.id, claimed.versionId),
        eq(versions.projectId, claimed.projectId),
      ),
    });
    if (!version) throw new Error("Saved source unavailable.");
    const files = await readArtifact(version);
    // Stop uses the same row lock, fencing creation/dispatch against cancellation.
    await withTerminalLock(id, async (tx, t) => {
      await authorizeTerminal(tx, t);
      if (t.status !== "starting") throw new Error("Terminal stopped.");
      sandbox = await Sandbox.getOrCreate({
        name: claimed.sandboxName!,
        ports: [],
        runtime: "node24",
        persistent: false,
        timeout: Math.max(1000, claimed.expiresAt.getTime() - Date.now()),
        networkPolicy: { allow: ["registry.npmjs.org"] },
        env: { CI: "true", NEXT_TELEMETRY_DISABLED: "1" },
        signal: signal(),
      });
    });
    if (!sandbox) throw new Error("Sandbox unavailable.");
    const instance = sandbox as Sandbox;
    let install: Command | undefined;
    await withTerminalLock(id, async (tx, t) => {
      await authorizeTerminal(tx, t);
      if (t.status !== "starting") throw new Error("Terminal stopped.");
      await instance.createUser("runner", { signal: signal() });
      const user = instance.asUser("runner");
      await user.mkDir(terminalWorkspace, { signal: signal() });
      await user.writeFiles(
        files.map((f) => ({
          path: `${terminalWorkspace}/${f.path}`,
          content: Buffer.from(f.content),
        })),
        { signal: signal() },
      );
      // Dispatch under the Stop lock, then wait outside it so Stop stays available.
      install = await user.runCommand({
        cmd: "env",
        args: [
          ...environment,
          "npm",
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        cwd: terminalWorkspace,
        detached: true,
        timeoutMs: 120000,
        signal: signal(),
      });
    });
    if (!install) throw new Error("Installation did not start.");
    const installed = await (install as Command).wait({
      signal: AbortSignal.timeout(130000),
    });
    if (installed.exitCode !== 0)
      throw new AppError(
        422,
        "terminal_install",
        "Terminal setup could not install the saved dependencies. Close it and try a fresh terminal.",
      );
    await withTerminalLock(id, async (tx, t) => {
      await authorizeTerminal(tx, t);
      if (t.status !== "starting") throw new Error("Terminal stopped.");
      await instance.updateNetworkPolicy("deny-all", { signal: signal() });
      await tx
        .update(terminals)
        .set({ status: "ready", error: null })
        .where(eq(terminals.id, id));
    });
    return claimed.expiresAt.toISOString();
  } catch (error) {
    await shutdown(
      id,
      sandbox,
      error instanceof AppError
        ? error.message
        : "Terminal setup could not complete. Close it and try again.",
    );
    return null;
  }
}

export async function executeTerminalCommand(commandId: string) {
  const entry = await database().query.terminalCommands.findFirst({
    where: eq(terminalCommands.id, commandId),
  });
  if (!entry || !["queued", "running"].includes(entry.status)) return;
  let sandbox: Sandbox | undefined;
  let command: Command | undefined;
  const output = new TerminalOutput();
  const abort = new AbortController();
  let finished = false;
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeMonitor: (() => void) | undefined;
  try {
    // Claim before dispatch. A replay of an uncertain dispatch terminates the
    // terminal; it never runs the user's command a second time.
    const terminal = await withTerminalLock(entry.terminalId, async (tx, t) => {
      await authorizeTerminal(tx, t);
      const fresh = await tx.query.terminalCommands.findFirst({
        where: eq(terminalCommands.id, commandId),
      });
      if (
        fresh?.status !== "queued" ||
        t.status !== "ready" ||
        t.activeCommandId !== commandId
      )
        throw new Error("Command dispatch is no longer safe to repeat.");
      await tx
        .update(terminalCommands)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(terminalCommands.id, commandId));
      return t;
    });
    await withTerminalLock(terminal.id, async (tx, t) => {
      await authorizeTerminal(tx, t);
      if (
        t.status !== "ready" ||
        t.activeCommandId !== commandId ||
        !t.sandboxName
      )
        throw new Error("Terminal stopped.");
      sandbox = await Sandbox.get({ name: t.sandboxName, signal: signal() });
      command = await sandbox.asUser("runner").runCommand({
        cmd: "env",
        args: [
          ...environment,
          "bash",
          "--noprofile",
          "--norc",
          "-c",
          entry.command,
        ],
        cwd: terminalWorkspace,
        detached: true,
        timeoutMs: terminalLimits.commandMs,
        signal: signal(),
      });
    });
    if (!command || !sandbox) throw new Error("Command unavailable.");
    const running = command as Command;
    const instance = sandbox as Sandbox;
    const deadline = Math.min(
      Date.now() + terminalLimits.commandMs,
      terminal.expiresAt.getTime(),
    );
    const flush = async (final = false) => {
      await database()
        .update(terminalCommands)
        .set({ output: output.text(final) })
        .where(
          and(
            eq(terminalCommands.id, commandId),
            eq(terminalCommands.status, "running"),
          ),
        );
    };
    let lastFlush = 0;
    const collect = async () => {
      for await (const log of running.logs({ signal: abort.signal })) {
        if (output.append(log.data))
          throw new AppError(
            422,
            "output_limit",
            "Output limit reached. The terminal was stopped.",
          );
        if (Date.now() - lastFlush > 250) {
          await flush();
          lastFlush = Date.now();
        }
      }
    };
    const monitor = async () => {
      while (!finished) {
        await new Promise<void>((resolve) => {
          wakeMonitor = resolve;
          monitorTimer = setTimeout(resolve, 1000);
        });
        if (finished) return;
        if (Date.now() >= deadline)
          throw new AppError(
            408,
            "timed_out",
            "Command timed out. The terminal was stopped.",
          );
        const project = await requireProject(
          terminal.ownerId,
          terminal.projectId,
        );
        if (project.archived)
          throw new AppError(
            403,
            "terminal_access",
            "Terminal access is no longer available.",
          );
        const t = await database().query.terminals.findFirst({
          where: eq(terminals.id, terminal.id),
        });
        if (!t || t.status !== "ready" || t.activeCommandId !== commandId)
          throw new AppError(409, "cancelled", "Terminal stopped.");
      }
    };
    const complete = async () => {
      const result = await running.wait({ signal: abort.signal });
      if (result.exitCode === 137 || Date.now() >= deadline)
        throw new AppError(
          408,
          "timed_out",
          "Command timed out. The terminal was stopped.",
        );
      // All commands run as a dedicated unprivileged user. Kill descendants,
      // including detached process groups, before releasing the command slot.
      await withTerminalLock(terminal.id, async (tx, t) => {
        await authorizeTerminal(tx, t);
        if (t.status !== "ready" || t.activeCommandId !== commandId)
          throw new AppError(409, "cancelled", "Terminal stopped.");
        const killed = await instance.runCommand({
          cmd: "pkill",
          args: ["-KILL", "-u", "runner"],
          sudo: true,
          timeoutMs: 10000,
          signal: signal(),
        });
        if (killed.exitCode !== 0 && killed.exitCode !== 1)
          throw new Error("Process cleanup failed.");
        const remaining = await instance.runCommand({
          cmd: "pgrep",
          args: ["-u", "runner"],
          sudo: true,
          timeoutMs: 10000,
          signal: signal(),
        });
        if (remaining.exitCode !== 1)
          throw new Error("Process cleanup could not be confirmed.");
      });
      return result;
    };
    const [, result] = await Promise.race([
      Promise.all([collect(), complete()]),
      monitor().then(() => {
        throw new Error("Command interrupted.");
      }),
    ]);
    await flush(true);
    await withTerminalLock(terminal.id, async (tx, t) => {
      await authorizeTerminal(tx, t);
      if (t.status !== "ready" || t.activeCommandId !== commandId) return;
      await tx
        .update(terminalCommands)
        .set({
          status: result.exitCode === 0 ? "completed" : "failed",
          exitCode: result.exitCode,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(terminalCommands.id, commandId),
            eq(terminalCommands.status, "running"),
          ),
        );
      await tx
        .update(terminals)
        .set({ activeCommandId: null })
        .where(eq(terminals.id, terminal.id));
    });
  } catch (error) {
    abort.abort();
    const reason =
      error instanceof AppError
        ? error.message
        : "Command execution could not be confirmed. The terminal was stopped; the command will not be replayed.";
    // Preserve only sanitized, bounded output, including on cancellation.
    try {
      await database()
        .update(terminalCommands)
        .set({ output: output.text(true) })
        .where(eq(terminalCommands.id, commandId));
    } finally {
      await shutdown(
        entry.terminalId,
        sandbox,
        reason,
        error instanceof AppError ? error.code : "failed",
      );
    }
  } finally {
    finished = true;
    abort.abort();
    clearTimeout(monitorTimer);
    wakeMonitor?.();
  }
}
