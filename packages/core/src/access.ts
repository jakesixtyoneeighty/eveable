import { and, eq } from "drizzle-orm";
import { database } from "@eveable/core/db";
import { members, projects } from "@eveable/core/schema";
import { AppError } from "@eveable/core/errors";
export async function requireMember(userId: string | null) {
  if (!userId)
    throw new AppError(401, "sign_in_required", "Sign in to continue.");
  const member = await database().query.members.findFirst({
    where: and(eq(members.userId, userId), eq(members.active, true)),
  });
  if (!member)
    throw new AppError(
      403,
      "invitation_required",
      "Your account needs active Eveable membership.",
    );
  return member;
}
export async function requireProject(userId: string, projectId: string) {
  await requireMember(userId);
  const project = await database().query.projects.findFirst({
    where: and(eq(projects.id, projectId), eq(projects.ownerId, userId)),
  });
  if (!project) throw new AppError(404, "not_found", "Project not found.");
  return project;
}
export function requireOrigin(request: Request, origin: string) {
  if (
    request.headers.get("origin") !== new URL(origin).origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError(403, "invalid_origin", "Request origin is not allowed.");
}
