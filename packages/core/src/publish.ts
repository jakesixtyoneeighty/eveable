import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import {
  deployments,
  projects,
  versions,
  activity,
} from "@eveable/core/schema";
import { requireOperation, finishOperation } from "@eveable/core/operations";
import { readArtifact } from "@eveable/core/artifacts";
import { AppError, required } from "@eveable/core/errors";
import { z } from "zod";
const deploymentSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    readyState: z.string().optional(),
    alias: z.array(z.string()).optional(),
  })
  .passthrough();
async function vercel(path: string, init: RequestInit = {}) {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", required("VERCEL_TEAM_ID"));
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${required("VERCEL_TOKEN")}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new AppError(
      response.status === 404 ? 404 : 502,
      "deployment_provider",
      `Deployment service returned ${response.status}.`,
    );
  return response.status === 204 ? {} : response.json();
}
async function releaseContext(id: string) {
  const { op, project } = await requireOperation(id);
  const release = await database().query.deployments.findFirst({
    where: eq(deployments.operationId, id),
  });
  const version = op.versionId
    ? await database().query.versions.findFirst({
        where: and(
          eq(versions.id, op.versionId),
          eq(versions.projectId, op.projectId),
        ),
      })
    : undefined;
  if (
    op.kind !== "publish" ||
    op.payload.confirmed !== true ||
    !release ||
    !version ||
    release.authorizedBy !== op.ownerId ||
    release.sourceHash !== version.hash ||
    op.payload.hash !== version.hash ||
    project.currentVersionId !== version.id
  )
    throw new AppError(
      403,
      "publish_not_authorized",
      "Release authorization no longer matches the current version.",
    );
  return { op, project, release, version };
}
export async function createRelease(id: string) {
  const { op, project, release, version } = await releaseContext(id);
  if (release.providerId) return;
  const name = `eveable-${project.id}`;
  let projectId = project.vercelProjectId;
  if (!projectId) {
    let remote;
    try {
      remote = await vercel(`/v9/projects/${name}`);
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 404) throw error;
      remote = await vercel("/v11/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          framework: "nextjs",
          publicSource: false,
          oidcTokenConfig: { enabled: false },
        }),
      });
    }
    projectId = z.object({ id: z.string() }).parse(remote).id;
    await database()
      .update(projects)
      .set({ vercelProjectId: projectId })
      .where(eq(projects.id, project.id));
  }
  // Do not inherit platform secrets or shared environment variables.
  const environment = await vercel(
    `/v10/projects/${encodeURIComponent(projectId)}/env`,
  );
  if (Array.isArray(environment.envs) && environment.envs.length)
    throw new AppError(
      409,
      "unexpected_environment",
      "Generated deployment projects must have no configured environment variables.",
    );
  if (release.status === "submitting") {
    // Recover an ambiguous POST without creating a second release.
    const list = await vercel(
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=100`,
    );
    const found = (
      list.deployments as
        | Array<{ uid: string; url: string; meta?: Record<string, string> }>
        | undefined
    )?.find((d) => d.meta?.eveableOperation === id);
    if (!found)
      throw new AppError(
        409,
        "release_uncertain",
        "Deployment submission is uncertain. Inspect the Vercel project before retrying.",
      );
    await database()
      .update(deployments)
      .set({
        providerId: found.uid,
        candidateUrl: verifiedVercelUrl(found.url),
        status: "building",
      })
      .where(eq(deployments.id, release.id));
    return;
  }
  const files = await readArtifact(version);
  await releaseContext(id);
  await database()
    .update(deployments)
    .set({ status: "submitting" })
    .where(eq(deployments.id, release.id));
  const deployment = deploymentSchema.parse(
    await vercel("/v13/deployments", {
      method: "POST",
      body: JSON.stringify({
        name,
        project: projectId,
        files: files.map((f) => ({
          file: f.path,
          data: Buffer.from(f.content).toString("base64"),
          encoding: "base64",
        })),
        meta: { eveableOperation: id, eveableHash: version.hash },
        projectSettings: {
          framework: "nextjs",
          installCommand: "npm install --ignore-scripts --no-audit --no-fund",
          buildCommand: "npm run build",
        },
      }),
    }),
  );
  await database()
    .update(deployments)
    .set({
      providerId: deployment.id,
      candidateUrl: verifiedVercelUrl(deployment.url),
      status: "building",
    })
    .where(eq(deployments.id, release.id));
}
export function verifiedVercelUrl(value: string) {
  const url = new URL(
    value.startsWith("https://") ? value : `https://${value}`,
  );
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".vercel.app") ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Untrusted deployment URL.");
  return url.origin;
}
async function healthy(url: string) {
  const r = await fetch(verifiedVercelUrl(url), {
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  return r.ok;
}
export async function checkRelease(id: string) {
  const { project, release, version } = await releaseContext(id);
  if (!release.providerId || !project.vercelProjectId)
    throw new Error("No submitted deployment.");
  const deployment = deploymentSchema.parse(
    await vercel(`/v13/deployments/${encodeURIComponent(release.providerId)}`),
  );
  if (["ERROR", "CANCELED"].includes(deployment.readyState ?? ""))
    throw new Error("Deployment build failed.");
  if (deployment.readyState !== "READY") return false;
  if (release.status !== "promoting") {
    if (!(await healthy(deployment.url)))
      throw new AppError(
        502,
        "candidate_unhealthy",
        "Candidate URL could not be verified. Check deployment protection settings.",
      );
    await releaseContext(id);
    // Persist the promotion phase before the external effect, allowing safe reconciliation.
    await database()
      .update(deployments)
      .set({ status: "promoting" })
      .where(eq(deployments.id, release.id));
    await vercel(
      `/v10/projects/${encodeURIComponent(project.vercelProjectId)}/promote/${encodeURIComponent(deployment.id)}`,
      { method: "POST", body: "{}" },
    );
    return false;
  }
  const production = await vercel(
    `/v9/projects/${encodeURIComponent(project.vercelProjectId)}`,
  );
  if (production.targets?.production?.id !== release.providerId) return false;
  const aliases = deployment.alias ?? [];
  const stable = aliases.find((a) => a === `eveable-${project.id}.vercel.app`);
  if (!stable) return false;
  const productionUrl = verifiedVercelUrl(stable);
  if (!(await healthy(productionUrl))) return false;
  await releaseContext(id);
  await database().transaction(async (tx) => {
    await tx
      .update(deployments)
      .set({ status: "published", productionUrl })
      .where(eq(deployments.id, release.id));
    await tx
      .update(projects)
      .set({
        publishedVersionId: version.id,
        deploymentUrl: productionUrl,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));
    await tx
      .insert(activity)
      .values({
        projectId: project.id,
        eventKey: `published:${release.id}`,
        kind: "published",
        data: { versionId: version.id, url: productionUrl },
      })
      .onConflictDoNothing();
  });
  await finishOperation(id, "completed", "published");
  return true;
}

/** Recover an interrupted release without pretending that an uncertain promotion failed. */
export async function failRelease(id: string) {
  const release = await database().query.deployments.findFirst({
    where: eq(deployments.operationId, id),
  });
  if (!release || release.status === "published") return;
  const project = await database().query.projects.findFirst({
    where: eq(projects.id, release.projectId),
  });
  if (!["promoting", "promotion_unverified"].includes(release.status)) {
    await database()
      .update(deployments)
      .set({ status: "failed" })
      .where(eq(deployments.id, release.id));
    await finishOperation(
      id,
      "failed",
      "failed",
      "Publishing failed before promotion. Your saved version and previous release are unchanged.",
    );
    return;
  }
  // Compensation is restricted to the previously recorded release of this same project.
  const previous = project?.publishedVersionId
    ? await database().query.deployments.findFirst({
        where: and(
          eq(deployments.projectId, release.projectId),
          eq(deployments.versionId, project.publishedVersionId),
          eq(deployments.status, "published"),
        ),
      })
    : undefined;
  try {
    if (
      !project?.vercelProjectId ||
      !previous?.providerId ||
      !previous.productionUrl
    )
      throw new Error("No previous verified release.");
    await vercel(
      `/v10/projects/${encodeURIComponent(project.vercelProjectId)}/promote/${encodeURIComponent(previous.providerId)}`,
      { method: "POST", body: "{}" },
    );
    const remote = await vercel(
      `/v9/projects/${encodeURIComponent(project.vercelProjectId)}`,
    );
    if (
      remote.targets?.production?.id !== previous.providerId ||
      !(await healthy(previous.productionUrl))
    )
      throw new Error("Rollback not yet verified.");
    await database()
      .update(deployments)
      .set({ status: "rolled_back" })
      .where(eq(deployments.id, release.id));
    await finishOperation(
      id,
      "failed",
      "failed",
      "The new release could not be verified. The previous production release was restored and verified.",
    );
  } catch {
    await database()
      .update(deployments)
      .set({ status: "promotion_unverified" })
      .where(eq(deployments.id, release.id));
    await finishOperation(
      id,
      "blocked",
      "blocked",
      "Production promotion could not be verified. An operator must reconcile the live destination before another publish. Saved versions and editing remain available.",
    );
  }
}

/** Read-only provider inspection; operators use this after uncertain promotion or rollback. */
export async function reconcileRelease(id: string) {
  const release = await database().query.deployments.findFirst({
    where: eq(deployments.operationId, id),
  });
  if (!release || release.status !== "promotion_unverified")
    throw new Error("An uncertain release operation is required.");
  const project = await database().query.projects.findFirst({
    where: eq(projects.id, release.projectId),
  });
  if (!project?.vercelProjectId) throw new Error("Vercel project is missing.");
  const remote = await vercel(
    `/v9/projects/${encodeURIComponent(project.vercelProjectId)}`,
  );
  const providerId = remote.targets?.production?.id;
  if (!providerId)
    throw new Error(
      "No production target is reported yet. Check Vercel before retrying.",
    );
  const known = await database().query.deployments.findFirst({
    where: and(
      eq(deployments.projectId, project.id),
      eq(deployments.providerId, providerId),
    ),
  });
  if (!known)
    throw new Error(
      "Production points to an unrecognized deployment. Operator investigation is required.",
    );
  const productionUrl = verifiedVercelUrl(`eveable-${project.id}.vercel.app`);
  if (!(await healthy(productionUrl)))
    throw new Error("Production URL is not healthy.");
  await database().transaction(async (tx) => {
    await tx
      .update(deployments)
      .set({ status: known.id === release.id ? "published" : "rolled_back" })
      .where(eq(deployments.id, release.id));
    await tx
      .update(deployments)
      .set({ status: "published", productionUrl })
      .where(eq(deployments.id, known.id));
    await tx
      .update(projects)
      .set({
        publishedVersionId: known.versionId,
        deploymentUrl: productionUrl,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));
  });
  return {
    status: known.id === release.id ? "published" : "rolled_back",
    productionUrl,
    versionId: known.versionId,
  };
}
