"use client";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { api, type ProjectState, type Version } from "@/lib/client";
const CodeEditor = lazy(() => import("./code-editor"));
type SourceFile = { path: string; content: string };
type Draft = {
  files: SourceFile[];
  original: SourceFile[];
  path: string;
  revision: number;
};

export function CodePanel({
  id,
  version,
  state,
  busy,
  selectVersion,
  onSaved,
}: {
  id: string;
  version: Version;
  state: ProjectState;
  busy: boolean;
  selectVersion: (version: Version) => void;
  onSaved: (version: Version) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [loadFailure, setLoadFailure] = useState<{
    versionId: string;
    message: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [sending, setSending] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [submitted, setSubmitted] = useState<{
    id: string;
    versionId: string;
    files: SourceFile[];
  } | null>(null);
  const requestKey = useRef<{ body: string; key: string } | null>(null);
  const handled = useRef("");
  const draft = drafts[version.id];
  const loading = !draft && loadFailure?.versionId !== version.id;
  const current = state.versions.find(
    (v) => v.id === state.project.currentVersionId,
  );
  const historical = version.id !== current?.id;
  const pending = !!submitted;
  const locked =
    busy ||
    sending ||
    pending ||
    historical ||
    !!state.pending.length ||
    state.project.archived;
  const changed =
    draft?.files.filter(
      (file, i) => file.content !== draft.original[i].content,
    ) ?? [];
  const anyDirty = Object.values(drafts).some((d) =>
    d.files.some((f, i) => f.content !== d.original[i].content),
  );
  useEffect(() => {
    if (draft) return;
    const abort = new AbortController();
    void api<{ files: SourceFile[] }>(`/${id}/versions/${version.id}`, {
      signal: abort.signal,
    })
      .then(({ files }) => {
        if (!abort.signal.aborted)
          setDrafts((prev) => ({
            ...prev,
            [version.id]: {
              files,
              original: files,
              path: files[0]?.path ?? "",
              revision: 0,
            },
          }));
      })
      .catch((e: Error) => {
        if (!abort.signal.aborted)
          setLoadFailure({ versionId: version.id, message: e.message });
      });
    return () => abort.abort();
  }, [id, version.id, draft, retry]);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    // Next.js links otherwise leave without giving the browser an unload event.
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a");
      if (
        anchor &&
        !anchor.target &&
        !anchor.hasAttribute("download") &&
        !anchor.href.includes("/export") &&
        new URL(anchor.href).pathname !== location.pathname &&
        !window.confirm(
          "Leave this project? Unsaved code changes will be lost.",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", navigate, true);
    };
  }, [anyDirty]);
  useEffect(() => {
    if (!submitted || handled.current === submitted.id) return;
    const abort = new AbortController();
    async function poll() {
      if (!submitted) return;
      try {
        const result = await api<{
          status: string;
          error: string | null;
          version: Version | null;
        }>(`/${id}/operations/${submitted.id}`, { signal: abort.signal });
        if (abort.signal.aborted || handled.current === submitted.id) return;
        if (result.status === "completed" && result.version) {
          handled.current = submitted.id;
          setDrafts((prev) => ({
            ...prev,
            [submitted.versionId]: {
              ...prev[submitted.versionId],
              files: prev[submitted.versionId].original,
              revision: prev[submitted.versionId].revision + 1,
            },
            [result.version!.id]: {
              files: submitted.files,
              original: submitted.files,
              path: prev[submitted.versionId]?.path ?? submitted.files[0].path,
              revision: 0,
            },
          }));
          setSubmitted(null);
          onSaved(result.version);
        } else if (["failed", "blocked"].includes(result.status)) {
          handled.current = submitted.id;
          setError(
            result.error ??
              "Changes could not be saved. Your draft is still here.",
          );
          setSubmitted(null);
        }
      } catch {
        /* Keep the draft and poll again after a transient disconnect. */
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [id, submitted, onSaved]);
  const updateDraft = (update: Partial<Draft>) =>
    setDrafts((prev) => ({
      ...prev,
      [version.id]: { ...prev[version.id], ...update },
    }));
  async function save() {
    if (locked || !draft || !changed.length) return;
    const body = JSON.stringify({
      kind: "code_edit",
      versionId: version.id,
      hash: version.hash,
      files: changed,
    });
    if (new TextEncoder().encode(body).length > 3_000_000) {
      setError(
        "These changes exceed the 3 MB save limit. Save fewer files at a time.",
      );
      return;
    }
    if (requestKey.current?.body !== body)
      requestKey.current = { body, key: crypto.randomUUID() };
    setSending(true);
    setError("");
    try {
      const result = await api<{ id: string }>(`/${id}/operations`, {
        method: "POST",
        headers: { "idempotency-key": requestKey.current.key },
        body,
      });
      setSubmitted({
        id: result.id,
        versionId: version.id,
        files: draft.files,
      });
      requestKey.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  const file = draft?.files.find((f) => f.path === draft.path);
  return (
    <div className="source-panel code-panel">
      <div className="source-header code-header">
        <span>
          {!draft
            ? loading
              ? "Loading source…"
              : "Source unavailable"
            : historical
              ? "Saved version"
              : changed.length
                ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed`
                : "All changes saved"}
        </span>
        <div className="code-actions">
          <a
            className="icon-button"
            aria-label="Download saved code"
            title="Download saved code"
            href={`/api/projects/${id}/versions/${version.id}/export`}
          >
            <Download size={15} />
          </a>
          <button
            className="text-button"
            disabled={!changed.length || sending || pending}
            onClick={() => setDiscard(true)}
          >
            <RotateCcw size={13} /> Revert
          </button>
          <button
            className="primary-button"
            disabled={locked || !changed.length}
            onClick={() => void save()}
          >
            {sending || pending ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Play size={14} />
            )}{" "}
            {sending || pending ? "Checking changes…" : "Save & Preview"}
          </button>
        </div>
      </div>
      {historical && (
        <div className="code-notice">
          {changed.length
            ? "A newer version was saved. Your draft is retained; compare it with the latest code before reapplying changes."
            : "This saved version is read-only."}{" "}
          {current && (
            <button
              className="text-button"
              onClick={() => selectVersion(current)}
            >
              Open latest code
            </button>
          )}
        </div>
      )}
      {!historical && !!state.pending.length && (
        <div className="code-notice">
          Answer the pending design approval before editing code.
        </div>
      )}
      {(error || (!draft && loadFailure?.versionId === version.id)) && (
        <div className="code-notice code-error" role="alert">
          {error || loadFailure?.message}{" "}
          {!draft && (
            <button
              className="text-button"
              onClick={() => {
                setLoadFailure(null);
                setRetry((n) => n + 1);
              }}
            >
              Retry loading source
            </button>
          )}
        </div>
      )}
      {discard && (
        <div className="code-notice" role="alert">
          Discard changes to this version?{" "}
          <button
            className="text-button"
            onClick={() => {
              if (draft)
                updateDraft({
                  files: draft.original,
                  revision: draft.revision + 1,
                });
              setDiscard(false);
            }}
          >
            Discard changes
          </button>
          <button className="text-button" onClick={() => setDiscard(false)}>
            Keep editing
          </button>
        </div>
      )}
      <div className="source-body">
        <nav aria-label="Source files">
          {draft?.files.map((f, i) => (
            <button
              key={f.path}
              className={draft.path === f.path ? "active" : ""}
              aria-current={draft.path === f.path ? "true" : undefined}
              onClick={() => updateDraft({ path: f.path })}
            >
              {f.path}
              {f.content !== draft.original[i].content && (
                <span className="dirty-dot" aria-label="Unsaved changes">
                  ●
                </span>
              )}
            </button>
          ))}
        </nav>
        {file ? (
          <Suspense fallback={<p className="empty">Opening editor…</p>}>
            <CodeEditor
              documentId={`${version.id}:${draft.revision}:${file.path}`}
              path={file.path}
              content={file.content}
              readOnly={locked}
              onChange={(content) =>
                updateDraft({
                  files: draft.files.map((f) =>
                    f.path === file.path ? { ...f, content } : f,
                  ),
                })
              }
            />
          </Suspense>
        ) : (
          <p className="empty">
            {loading ? "Loading source…" : "Source is unavailable."}
          </p>
        )}
      </div>
      <div className="code-footer">
        <span>{draft?.path ?? version.summary}</span>
        <span>{historical ? "READ ONLY" : "DRAFTS STAY IN THIS TAB"}</span>
      </div>
    </div>
  );
}
