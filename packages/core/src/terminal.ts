import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { APIError, Sandbox } from "@vercel/sandbox";
import { database } from "@eveable/core/db";
import {
  members,
  projects,
  terminals,
  terminalCommands,
  versions,
} from "@eveable/core/schema";
import { requireProject } from "@eveable/core/access";
import { AppError } from "@eveable/core/errors";
import { terminalCommand, terminalLimits } from "@eveable/core/terminal-output";

export type Terminal = typeof terminals.$inferSelect;
export type TerminalTransaction = Parameters<
  Parameters<ReturnType<typeof database>["transaction"]>[0]
>[0];
export const terminalActive = [
  "queued",
  "starting",
  "ready",
  "stopping",
  "cleanup_required",
];
const terminalClosed = ["closed", "failed", "expired"];
function keyValid(key: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key))
    throw new AppError(
      400,
      "idempotency_required",
      "An idempotency key is required.",
    );
}

export async function authorizeTerminal(
  tx: TerminalTransaction,
  terminal: Terminal,
) {
  const member = await tx
    .select()
    .from(members)
    .where(and(eq(members.userId, terminal.ownerId), eq(members.active, true)))
    .for("share");
  const project = await tx.query.projects.findFirst({
    where: and(
      eq(projects.id, terminal.projectId),
      eq(projects.ownerId, terminal.ownerId),
    ),
  });
  if (!member.length || !project || project.archived)
    throw new AppError(
      403,
      "terminal_access",
      "Terminal access is no longer available.",
    );
  if (terminal.expiresAt.getTime() <= Date.now())
    throw new AppError(
      410,
      "terminal_expired",
      "This terminal expired. Start a fresh terminal.",
    );
}

export async function withTerminalLock<T>(
  id: string,
  fn: (tx: TerminalTransaction, terminal: Terminal) => Promise<T>,
) {
  return database().transaction(async (tx) => {
    const [terminal] = await tx
      .select()
      .from(terminals)
      .where(eq(terminals.id, id))
      .for("update");
    if (!terminal) throw new AppError(404, "not_found", "Terminal not found.");
    return fn(tx, terminal);
  });
}

export async function admitTerminal(
  ownerId: string,
  projectId: string,
  key: string,
  versionId: string,
) {
  keyValid(key);
  await requireProject(ownerId, projectId);
  return database().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`,
    );
    const member = await tx
      .select()
      .from(members)
      .where(and(eq(members.userId, ownerId), eq(members.active, true)))
      .for("share");
    if (!member.length)
      throw new AppError(
        403,
        "terminal_access",
        "Terminal access is no longer available.",
      );
    const [project] = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
      .for("update");
    if (!project) throw new AppError(404, "not_found", "Project not found.");
    const previous = await tx.query.terminals.findFirst({
      where: and(eq(terminals.projectId, projectId), eq(terminals.key, key)),
    });
    if (previous) {
      if (previous.versionId !== versionId)
        throw new AppError(
          409,
          "key_reused",
          "Use a new request for a different version.",
        );
      return previous;
    }
    if (project.archived || project.activeOperationId)
      throw new AppError(
        409,
        "busy",
        "Wait for the project operation to finish before starting a terminal.",
      );
    const version = await tx.query.versions.findFirst({
      where: and(eq(versions.id, versionId), eq(versions.projectId, projectId)),
    });
    if (!version || project.currentVersionId !== version.id)
      throw new AppError(
        409,
        "version_changed",
        "Open the latest saved version before starting a terminal.",
      );
    const other = await tx.query.terminals.findFirst({
      where: and(
        eq(terminals.ownerId, ownerId),
        inArray(terminals.status, terminalActive),
      ),
    });
    if (other)
      throw new AppError(
        409,
        "terminal_busy",
        "Close your existing terminal before starting another.",
      );
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const [daily] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(terminals)
      .where(
        and(eq(terminals.ownerId, ownerId), gte(terminals.createdAt, day)),
      );
    if (daily.count >= terminalLimits.dailyStarts)
      throw new AppError(
        429,
        "terminal_limit",
        "Daily terminal limit reached. Try again tomorrow.",
      );
    const [terminal] = await tx
      .insert(terminals)
      .values({
        projectId,
        ownerId,
        versionId,
        key,
        expiresAt: new Date(Date.now() + terminalLimits.lifetimeMs),
      })
      .returning();
    return terminal;
  });
}

export async function admitTerminalCommand(
  ownerId: string,
  projectId: string,
  terminalId: string,
  key: string,
  input: string,
) {
  keyValid(key);
  const command = terminalCommand(input);
  await requireProject(ownerId, projectId);
  return withTerminalLock(terminalId, async (tx, terminal) => {
    if (terminal.ownerId !== ownerId || terminal.projectId !== projectId)
      throw new AppError(404, "not_found", "Terminal not found.");
    await authorizeTerminal(tx, terminal);
    const previous = await tx.query.terminalCommands.findFirst({
      where: and(
        eq(terminalCommands.terminalId, terminalId),
        eq(terminalCommands.key, key),
      ),
    });
    if (previous) {
      if (previous.command !== command)
        throw new AppError(
          409,
          "key_reused",
          "Use a new request for a different command.",
        );
      return previous;
    }
    if (terminal.status !== "ready" || terminal.activeCommandId)
      throw new AppError(
        409,
        "terminal_busy",
        "Wait for the current command or stop the terminal.",
      );
    if (terminal.commandCount >= terminalLimits.commands)
      throw new AppError(
        429,
        "terminal_limit",
        "This terminal reached its command limit. Close it and start a fresh terminal.",
      );
    const [entry] = await tx
      .insert(terminalCommands)
      .values({ terminalId, key, command })
      .returning();
    await tx
      .update(terminals)
      .set({
        activeCommandId: entry.id,
        commandCount: terminal.commandCount + 1,
      })
      .where(eq(terminals.id, terminalId));
    return entry;
  });
}

export async function stopTerminal(
  id: string,
  reason = "Terminal stopped.",
  status = "closed",
  commandStatus = "cancelled",
  instance?: Sandbox,
) {
  const terminal = await withTerminalLock(id, async (tx, t) => {
    if (terminalClosed.includes(t.status)) return null;
    await tx
      .update(terminals)
      .set({ status: "stopping", error: reason })
      .where(eq(terminals.id, id));
    return t;
  });
  if (!terminal) return;
  // Serialize provider cleanup too: a concurrent Stop must not resume a
  // sandbox after another Stop has already confirmed it closed.
  await withTerminalLock(id, async (tx, t) => {
    if (terminalClosed.includes(t.status)) return;
    let stopped = !t.sandboxName;
    if (t.sandboxName) {
      try {
        const sandbox =
          instance ??
          (await Sandbox.get({
            name: t.sandboxName,
            signal: AbortSignal.timeout(15000),
          }));
        const result = await sandbox.stop({
          signal: AbortSignal.timeout(15000),
        });
        stopped = ["stopped", "failed", "aborted"].includes(result.status);
      } catch (error) {
        // Missing expired, nonpersistent sandboxes are already gone. During setup
        // a missing sandbox may still be an ambiguous create; retain that slot.
        stopped =
          error instanceof APIError &&
          error.response.status === 404 &&
          t.expiresAt.getTime() <= Date.now();
      }
    }
    await tx
      .update(terminals)
      .set({
        status: stopped ? status : "cleanup_required",
        error: stopped
          ? reason
          : "Stopping could not be confirmed. Retry Stop before starting another terminal.",
        activeCommandId: stopped ? null : t.activeCommandId,
      })
      .where(eq(terminals.id, id));
    if (t.activeCommandId)
      await tx
        .update(terminalCommands)
        .set({
          status: stopped ? commandStatus : "uncertain",
          error: reason,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(terminalCommands.id, t.activeCommandId),
            inArray(terminalCommands.status, [
              "queued",
              "running",
              "uncertain",
            ]),
          ),
        );
  });
}

export async function terminalState(ownerId: string, projectId: string) {
  await requireProject(ownerId, projectId);
  const terminal = await database().query.terminals.findFirst({
    where: and(
      eq(terminals.projectId, projectId),
      eq(terminals.ownerId, ownerId),
    ),
    orderBy: desc(terminals.createdAt),
  });
  if (!terminal) return { terminal: null, commands: [] };
  const commands = await database().query.terminalCommands.findMany({
    where: eq(terminalCommands.terminalId, terminal.id),
    orderBy: asc(terminalCommands.createdAt),
    limit: terminalLimits.commands,
  });
  return {
    terminal: {
      id: terminal.id,
      versionId: terminal.versionId,
      status: terminal.status,
      expiresAt: terminal.expiresAt,
      commandCount: terminal.commandCount,
      error: terminal.error,
      busy: !!terminal.activeCommandId,
    },
    commands: commands.map((c) => ({
      id: c.id,
      command: c.command,
      status: c.status,
      output: c.output,
      exitCode: c.exitCode,
      error: c.error,
      createdAt: c.createdAt,
    })),
  };
}
