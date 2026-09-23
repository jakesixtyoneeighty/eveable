import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { start } from "workflow/api";
import { database } from "@eveable/core/db";
import { terminals, terminalCommands } from "@eveable/core/schema";
import {
  admitTerminal,
  admitTerminalCommand,
  stopTerminal,
  terminalState,
} from "@eveable/core/terminal";
import { AppError } from "@eveable/core/errors";
import { body } from "./http";
import { runTerminalStartup, runTerminalCommand } from "../workflows/terminal";

// The parent route has already enforced membership, project ownership, and
// same-origin mutations. Worker admission independently rechecks authorization.
export async function terminalRoute(
  request: Request,
  path: string[],
  ownerId: string,
  projectId: string,
) {
  const json = (value: unknown) =>
    Response.json(value, { headers: { "cache-control": "no-store" } });
  const db = database();
  if (path.length === 2 && request.method === "GET")
    return json(await terminalState(ownerId, projectId));
  if (path.length === 2 && request.method === "POST") {
    const input = z.object({ versionId: z.uuid() }).parse(await body(request));
    const terminal = await admitTerminal(
      ownerId,
      projectId,
      request.headers.get("idempotency-key") ?? "",
      input.versionId,
    );
    const claim =
      terminal.status === "queued"
        ? await db
            .update(terminals)
            .set({ workflowId: "starting" })
            .where(
              and(eq(terminals.id, terminal.id), isNull(terminals.workflowId)),
            )
            .returning()
        : [];
    if (claim.length) {
      try {
        const run = await start(runTerminalStartup, [terminal.id]);
        await db
          .update(terminals)
          .set({ workflowId: run.runId })
          .where(eq(terminals.id, terminal.id));
      } catch {
        await db
          .update(terminals)
          .set({
            error:
              "Terminal dispatch could not be confirmed. Use Stop to close it before starting another.",
          })
          .where(eq(terminals.id, terminal.id));
        throw new AppError(
          503,
          "dispatch_uncertain",
          "Terminal dispatch could not be confirmed. Use Stop before starting another.",
        );
      }
    }
    return json({ id: terminal.id });
  }
  const terminalId = z.uuid().parse(path[2]);
  const terminal = await db.query.terminals.findFirst({
    where: and(
      eq(terminals.id, terminalId),
      eq(terminals.projectId, projectId),
      eq(terminals.ownerId, ownerId),
    ),
  });
  if (!terminal) throw new AppError(404, "not_found", "Terminal not found.");
  if (path.length === 4 && path[3] === "stop" && request.method === "POST") {
    await body(request);
    await stopTerminal(terminal.id);
    return json(await terminalState(ownerId, projectId));
  }
  if (
    path.length === 4 &&
    path[3] === "commands" &&
    request.method === "POST"
  ) {
    const input = z
      .object({ command: z.string().min(1).max(4000) })
      .parse(await body(request));
    const entry = await admitTerminalCommand(
      ownerId,
      projectId,
      terminal.id,
      request.headers.get("idempotency-key") ?? "",
      input.command,
    );
    const claim =
      entry.status === "queued"
        ? await db
            .update(terminalCommands)
            .set({ workflowId: "starting" })
            .where(
              and(
                eq(terminalCommands.id, entry.id),
                isNull(terminalCommands.workflowId),
              ),
            )
            .returning()
        : [];
    if (claim.length) {
      try {
        const run = await start(runTerminalCommand, [entry.id]);
        await db
          .update(terminalCommands)
          .set({ workflowId: run.runId })
          .where(eq(terminalCommands.id, entry.id));
      } catch {
        await db
          .update(terminalCommands)
          .set({
            error:
              "Command dispatch could not be confirmed. Use Stop; do not repeat the command with a new request.",
          })
          .where(eq(terminalCommands.id, entry.id));
        throw new AppError(
          503,
          "dispatch_uncertain",
          "Command dispatch could not be confirmed. Use Stop before running another command.",
        );
      }
    }
    return json({ id: entry.id, status: entry.status });
  }
  throw new AppError(404, "not_found", "Route not found.");
}
