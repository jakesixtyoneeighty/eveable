export type ProjectSummary = {
  id: string;
  name: string;
  status: string;
  archived: boolean;
  updatedAt: string;
  currentVersionId: string | null;
};
export type Version = {
  id: string;
  hash: string;
  summary: string;
  manifest: string[];
  createdAt: string;
  baseVersionId: string | null;
};
export type ProjectState = {
  project: {
    id: string;
    name: string;
    status: string;
    archived: boolean;
    currentVersionId: string | null;
    publishedVersionId: string | null;
    deploymentUrl: string | null;
    busy: boolean;
  };
  versions: Version[];
  pending: {
    requestId: string;
    prompt: string;
    options: { id: string; label: string }[];
  }[];
  preview: { id: string; versionId: string; status: string } | null;
  release: { status: string; url: string | null } | null;
  error: string | null;
};
export type Event = {
  id: string;
  cursor: number;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
};
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/projects${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
export function conversation(events: Event[]) {
  const messages: {
    id: string;
    role: "user" | "assistant";
    text: string;
    pending: boolean;
  }[] = [];
  const positions = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "user")
      messages.push({
        id: event.id,
        role: "user",
        text: String(event.data.text ?? ""),
        pending: false,
      });
    if (event.kind === "assistant" || event.kind === "assistant_delta") {
      const id = String(event.data.messageId ?? event.id);
      const item = {
        id,
        role: "assistant" as const,
        text: String(event.data.text ?? ""),
        pending: event.kind === "assistant_delta",
      };
      const position = positions.get(id);
      if (position === undefined) {
        positions.set(id, messages.length);
        messages.push(item);
      } else messages[position] = item;
    }
  }
  return messages;
}
export function statusLabel(status: string) {
  return (
    (
      {
        waiting: "Ready for your idea",
        queued: "Starting",
        streaming: "Working",
        awaiting_approval: "Your approval needed",
        preview_available: "Ready to preview",
        starting_preview: "Starting preview",
        publishing: "Publishing",
        published: "Published",
        failed: "Needs attention",
        blocked: "Blocked",
        completed: "Finished",
      } as Record<string, string>
    )[status] ?? status.replaceAll("_", " ")
  );
}
