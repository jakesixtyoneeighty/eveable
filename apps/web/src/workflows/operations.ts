import { sleep } from "workflow";
export async function runOperation(id: string) {
  "use workflow";
  try {
    const kind = await operationKind(id);
    if (kind === "code_edit") {
      for (const phase of [
        "prepare",
        "install",
        "typecheck",
        "build",
        "verify",
      ] as const) {
        if (!(await editCode(id, phase))) return;
      }
      return;
    }
    if (kind === "preview") {
      await buildPreview(id);
      return;
    }
    if (kind === "publish") {
      await beginPublish(id);
      for (let i = 0; i < 120; i++) {
        if (await checkPublish(id)) return;
        await sleep("5s");
      }
      throw new Error("Deployment timed out.");
    }
    await dispatch(id);
    for (let i = 0; i < 240; i++) {
      if (await reconcile(id)) return;
      await sleep("5s");
    }
    throw new Error("Run timed out.");
  } catch {
    await fail(id);
  }
}
async function editCode(
  id: string,
  phase: "prepare" | "install" | "typecheck" | "build" | "verify",
) {
  "use step";
  const { runCodeEditPhase, failCodeEdit } =
    await import("@eveable/core/code-edit");
  const { AppError } = await import("@eveable/core/errors");
  try {
    await runCodeEditPhase(id, phase);
    return true;
  } catch (error) {
    await failCodeEdit(
      id,
      error instanceof AppError
        ? error.message
        : "Code validation could not complete. Your draft and last saved version are unchanged. Try Save & Preview again.",
    );
    return false;
  }
}
async function operationKind(id: string) {
  "use step";
  const { requireOperation } = await import("@eveable/core/operations");
  return (await requireOperation(id)).op.kind;
}
async function dispatch(id: string) {
  "use step";
  const { dispatchOperation } = await import("../lib/runtime");
  await dispatchOperation(id);
}
async function reconcile(id: string) {
  "use step";
  const { reconcileOperation } = await import("../lib/runtime");
  return reconcileOperation(id);
}
async function buildPreview(id: string) {
  "use step";
  const { startPreview } = await import("@eveable/core/preview");
  await startPreview(id);
}
async function beginPublish(id: string) {
  "use step";
  const { createRelease } = await import("@eveable/core/publish");
  await createRelease(id);
}
async function checkPublish(id: string) {
  "use step";
  const { checkRelease } = await import("@eveable/core/publish");
  return checkRelease(id);
}
async function fail(id: string) {
  "use step";
  const { database } = await import("@eveable/core/db");
  const { operations } = await import("@eveable/core/schema");
  const { eq } = await import("drizzle-orm");
  const op = await database().query.operations.findFirst({
    where: eq(operations.id, id),
  });
  if (op?.kind === "publish") {
    const { failRelease } = await import("@eveable/core/publish");
    await failRelease(id);
    return;
  }
  if (op?.kind === "code_edit") {
    const { failCodeEdit } = await import("@eveable/core/code-edit");
    await failCodeEdit(
      id,
      "Code validation timed out. Your draft and last saved version are unchanged.",
    );
    return;
  }
  const { finishOperation } = await import("@eveable/core/operations");
  await finishOperation(
    id,
    "failed",
    "failed",
    "Operation failed or timed out. Your last saved version and published release are unchanged.",
  );
}
