import { sleep } from "workflow";

export async function runTerminalStartup(id: string) {
  "use workflow";
  const expiresAt = await prepare(id);
  if (expiresAt) {
    await sleep(new Date(expiresAt));
    await expire(id);
  }
}
export async function runTerminalCommand(id: string) {
  "use workflow";
  await execute(id);
}
async function prepare(id: string) {
  "use step";
  const { prepareTerminal } = await import("@eveable/core/terminal-runtime");
  return prepareTerminal(id);
}
async function execute(id: string) {
  "use step";
  const { executeTerminalCommand } =
    await import("@eveable/core/terminal-runtime");
  await executeTerminalCommand(id);
}
async function expire(id: string) {
  "use step";
  const { stopTerminal } = await import("@eveable/core/terminal");
  await stopTerminal(
    id,
    "Terminal expired. Start a fresh terminal from the latest saved version.",
    "expired",
    "timed_out",
  );
}
