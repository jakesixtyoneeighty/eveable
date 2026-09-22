import { z } from "zod";
import { notFound } from "next/navigation";
import Workspace from "@/components/workspace";
import { accessScreen } from "@/lib/page-access";
import { owned } from "@/lib/auth";
import { AppError } from "@eveable/core/errors";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await accessScreen();
  if (gate) return gate;
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  try {
    await owned(id);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  return <Workspace key={id} id={id} />;
}
