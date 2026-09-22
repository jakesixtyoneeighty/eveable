import "server-only";
import { auth } from "@clerk/nextjs/server";
import {
  requireMember,
  requireOrigin,
  requireProject,
} from "@eveable/core/access";
import { required } from "@eveable/core/errors";
export async function user() {
  const { userId } = await auth();
  const member = await requireMember(userId);
  return member.userId;
}
export async function owned(projectId: string) {
  return requireProject(await user(), projectId);
}
export function mutation(request: Request) {
  requireOrigin(request, required("APP_ORIGIN"));
}
