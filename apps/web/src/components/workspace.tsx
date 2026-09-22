"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Tabs from "@radix-ui/react-tabs";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Code2,
  Download,
  Eye,
  History,
  LoaderCircle,
  MessageSquare,
  Monitor,
  PanelLeft,
  Play,
  Plus,
  RotateCcw,
  Smartphone,
  Upload,
  X,
} from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import {
  api,
  conversation,
  statusLabel,
  type Event,
  type ProjectState,
  type ProjectSummary,
  type Version,
} from "@/lib/client";
import { Brand } from "./home";
import { Dialog } from "./ui/dialog";
type File = { path: string; content: string };
export default function Workspace({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<ProjectState | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [prompt, setPrompt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [tab, setTab] = useState("preview");
  const [panel, setPanel] = useState<"source" | "versions" | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [filePath, setFilePath] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<Version | null>(null);
  const [confirm, setConfirm] = useState<"publish" | "restore" | null>(null);
  const [chatWidth, setChatWidth] = useState(34);
  const [frameReady, setFrameReady] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null);
  const operationKey = useRef<{ body: string; key: string } | null>(null);
  const refresh = useCallback(async () => {
    const next = await api<ProjectState>(`/${id}`);
    setState(next);
  }, [id]);
  useEffect(() => {
    let active = true;
    void api<ProjectSummary[]>("")
      .then((v) => {
        if (active) setItems(v);
      })
      .catch(() => undefined);
    const update = () => {
      void refresh().catch((e) => {
        if (active) setError(e.message);
      });
    };
    update();
    const timer = setInterval(update, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const abort = new AbortController();
    let cursor = 0;
    let stopped = false;
    async function receive() {
      while (!stopped) {
        try {
          const r = await fetch(`/api/projects/${id}/stream?after=${cursor}`, {
            signal: abort.signal,
          });
          if (!r.ok || !r.body) throw new Error("Stream unavailable");
          setConnected(true);
          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (!line.trim()) continue;
              const event = JSON.parse(line) as Event;
              if (event.kind === "disconnected")
                throw new Error("Disconnected");
              if (event.cursor > cursor) {
                cursor = event.cursor;
                setEvents((prev) => [...prev, event]);
              }
            }
          }
        } catch {
          if (stopped) break;
          setConnected(false);
        }
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    void receive();
    return () => {
      stopped = true;
      abort.abort();
    };
  }, [id]);
  const messages = useMemo(() => conversation(events), [events]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, state?.pending.length]);
  const project = state?.project;
  const current = state?.versions.find(
    (v) => v.id === project?.currentVersionId,
  );
  const working = busy || !!project?.busy;
  const latestStage = [...events].reverse().find((e) => e.kind === "stage");
  async function operate(input: unknown) {
    setBusy(true);
    setError("");
    const body = JSON.stringify(input);
    if (operationKey.current?.body !== body)
      operationKey.current = { body, key: crypto.randomUUID() };
    try {
      await api(`/${id}/operations`, {
        method: "POST",
        headers: { "idempotency-key": operationKey.current.key },
        body,
      });
      operationKey.current = null;
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!prompt.trim() || working) return;
    const message = prompt;
    if (await operate({ kind: "message", message })) setPrompt("");
  }
  async function answer(requestId: string, optionId: string) {
    if (await operate({ kind: "approval", requestId, optionId, notes })) {
      setNotes("");
    }
  }
  async function source(version: Version) {
    setTab("preview");
    selectPanel("source");
    setSelectedVersion(version);
    setFiles([]);
    try {
      const data = await api<{ files: File[] }>(
        `/${id}/versions/${version.id}`,
      );
      setFiles(data.files);
      setFilePath(data.files[0]?.path ?? "");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const openPreview = useCallback(
    async (external = false) => {
      if (!state?.preview || state.preview.status !== "ready") return;
      setError("");
      try {
        const { origin, token } = await api<{ origin: string; token: string }>(
          `/${id}/preview-access`,
          {
            method: "POST",
            body: JSON.stringify({ previewId: state.preview.id }),
          },
        );
        const form = document.createElement("form");
        form.method = "POST";
        form.action = origin + "/__eveable_access";
        form.target = external ? "_blank" : `preview-${id}`;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "token";
        input.value = token;
        form.append(input);
        document.body.append(form);
        form.submit();
        form.remove();
        if (!external) setFrameReady(true);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [id, state],
  );
  const loadedPreview = useRef("");
  function selectPanel(next: "source" | "versions" | null) {
    setPanel(next);
    if (next) {
      loadedPreview.current = "";
      setFrameReady(false);
    }
  }
  useEffect(() => {
    if (panel) {
      loadedPreview.current = "";
      return;
    }
    if (
      state?.preview?.status === "ready" &&
      loadedPreview.current !== state.preview.id
    ) {
      loadedPreview.current = state.preview.id;
      void openPreview();
    }
  }, [state?.preview, openPreview, panel]);
  async function startPreview() {
    if (current) {
      setFrameReady(false);
      loadedPreview.current = "";
      await operate({ kind: "preview", versionId: current.id });
    }
  }
  const versionsPanel = (
    <div className="versions-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">PROJECT HISTORY</span>
          <h2>Every step, saved.</h2>
        </div>
        {panel && (
          <button
            className="icon-button"
            aria-label="Close versions"
            onClick={() => selectPanel(null)}
          >
            <X size={18} />
          </button>
        )}
      </div>
      {!state?.versions.length ? (
        <p className="empty">
          Your first saved version will appear after the build passes its
          checks.
        </p>
      ) : (
        state.versions.map((v, index) => (
          <article className="version-entry" key={v.id}>
            <span className="version-index">
              {String(state.versions.length - index).padStart(2, "0")}
            </span>
            <div>
              <strong>{v.summary}</strong>
              <p>{new Date(v.createdAt).toLocaleString()}</p>
              <div className="version-tags">
                {v.id === project?.currentVersionId && <span>Current</span>}
                {v.id === project?.publishedVersionId && (
                  <span className="published-tag">Published</span>
                )}
              </div>
              <div className="version-actions">
                <button onClick={() => void source(v)}>View source</button>
                <a href={`/api/projects/${id}/versions/${v.id}/export`}>
                  Download
                </a>
                <button
                  disabled={working}
                  onClick={() => {
                    setSelectedVersion(v);
                    setConfirm("restore");
                  }}
                >
                  Restore
                </button>
              </div>
            </div>
          </article>
        ))
      )}
    </div>
  );
  return (
    <div className="workspace">
      <header className="workspace-header">
        <Brand />
        <span className="header-divider" />
        <details className="project-switcher">
          <summary>
            {project?.name ?? "Opening project…"}
            <ChevronDown size={14} />
          </summary>
          <div className="switcher-menu">
            {items
              .filter((p) => !p.archived)
              .map((p) => (
                <Link href={`/projects/${p.id}`} key={p.id}>
                  {p.name}
                </Link>
              ))}
            <Link href="/">
              <Plus size={14} />
              New project
            </Link>
          </div>
        </details>
        <div className="workspace-header-right">
          {current && (
            <span className="version-label">
              V{state!.versions.length.toString().padStart(2, "0")}
              {project?.publishedVersionId &&
                project.currentVersionId !== project.publishedVersionId && (
                  <i title="Unpublished changes" />
                )}
            </span>
          )}
          <button
            className="primary-button"
            disabled={
              !current ||
              working ||
              !!state?.pending.length ||
              project?.archived
            }
            onClick={() => {
              setSelectedVersion(current ?? null);
              setConfirm("publish");
            }}
          >
            <Upload size={14} />
            Publish
          </button>
          <UserButton />
        </div>
      </header>
      <Tabs.Root value={tab} onValueChange={setTab} className="mobile-tabs">
        <Tabs.List aria-label="Workspace view">
          <Tabs.Trigger value="chat">
            <MessageSquare size={15} />
            Chat
          </Tabs.Trigger>
          <Tabs.Trigger value="preview">
            <Eye size={15} />
            Preview
          </Tabs.Trigger>
          <Tabs.Trigger value="versions">
            <History size={15} />
            Versions
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
      <div
        className="workspace-body"
        ref={split}
        style={{ "--chat-width": `${chatWidth}%` } as React.CSSProperties}
      >
        <section
          className={`chat-pane mobile-${tab === "chat" ? "visible" : "hidden"}`}
        >
          <div className="pane-heading">
            <span>
              <span className="tiny-cross">+</span> YOUR BUILD
            </span>
            <button
              className="icon-button"
              aria-label="Project home"
              onClick={() => router.push("/")}
            >
              <PanelLeft size={16} />
            </button>
          </div>
          <div className="conversation">
            <div className="conversation-intro">
              <span className="eyebrow">START WITH THE POSSIBILITIES</span>
              <h2>Let’s make it real.</h2>
              <p>We’ll agree on a direction before changing a single file.</p>
            </div>
            {messages.map((m) => (
              <article key={m.id} className={`message message-${m.role}`}>
                <span className="message-author">
                  {m.role === "user" ? "YOU" : "EVEABLE"}
                </span>
                <div>{m.text}</div>
              </article>
            ))}
            {state?.pending.map((request) => (
              <section className="approval" key={request.requestId}>
                <span className="eyebrow">A MOMENT FOR YOUR APPROVAL</span>
                <h3>Does this feel right?</h3>
                <p>{request.prompt}</p>
                <label htmlFor="revision-notes">
                  Revision notes <span>(if you want changes)</span>
                </label>
                <textarea
                  id="revision-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Keep the layout, but try a more restrained palette…"
                  rows={3}
                />
                <div className="approval-actions">
                  {request.options.map((option) => (
                    <button
                      key={option.id}
                      className={
                        option.label === "Approve and build"
                          ? "primary-button"
                          : "text-button"
                      }
                      disabled={
                        working ||
                        (option.label === "Revise design" && !notes.trim())
                      }
                      onClick={() => void answer(request.requestId, option.id)}
                    >
                      {option.label === "Approve and build" && (
                        <Check size={14} />
                      )}{" "}
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {working && (
              <div className="activity-status" role="status">
                <LoaderCircle size={14} className="spin" />
                {String(latestStage?.data.label ?? "Working on your project")}
              </div>
            )}
            <div ref={end} />
          </div>
          <div className="chat-bottom">
            {!connected && (
              <p className="connection-state" role="status">
                Connection interrupted. Reconnecting… Your run continues.
              </p>
            )}
            {(error || state?.error) && (
              <p className="error" role="alert">
                {error || state?.error}
              </p>
            )}
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label className="sr-only" htmlFor="message">
                Message Eveable
              </label>
              <textarea
                id="message"
                placeholder={
                  state?.pending.length
                    ? "Review the design above to continue…"
                    : "Describe what you’d like to change…"
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={
                  working || !!state?.pending.length || project?.archived
                }
                maxLength={16000}
                rows={3}
              />
              <div>
                <span>
                  {current
                    ? "Changes start with your approval."
                    : "Make something worth sharing."}
                </span>
                <button
                  className="send-button"
                  disabled={
                    !prompt.trim() ||
                    working ||
                    !!state?.pending.length ||
                    project?.archived
                  }
                  aria-label="Send message"
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </form>
            <p className="composer-note">
              Generated apps need your review before publishing.
            </p>
          </div>
        </section>
        <div
          className="resize-handle"
          role="separator"
          tabIndex={0}
          aria-label="Resize chat and preview"
          aria-orientation="vertical"
          aria-valuenow={chatWidth}
          aria-valuemin={24}
          aria-valuemax={50}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setChatWidth((w) =>
                Math.max(
                  24,
                  Math.min(50, w + (e.key === "ArrowRight" ? 2 : -2)),
                ),
              );
            }
          }}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={(e) => {
            if (
              e.currentTarget.hasPointerCapture(e.pointerId) &&
              split.current
            ) {
              const rect = split.current.getBoundingClientRect();
              setChatWidth(
                Math.max(
                  24,
                  Math.min(50, ((e.clientX - rect.left) / rect.width) * 100),
                ),
              );
            }
          }}
        />
        <section
          className={`preview-pane mobile-${tab === "preview" ? "visible" : "hidden"}`}
        >
          <div className="preview-toolbar">
            <div className="toolbar-tabs">
              <button
                className={!panel ? "selected" : ""}
                onClick={() => selectPanel(null)}
              >
                <Eye size={15} />
                Preview
              </button>
              <button
                disabled={!current}
                className={panel === "source" ? "selected" : ""}
                onClick={() => current && void source(current)}
              >
                <Code2 size={15} />
                Source
              </button>
              <button
                className={panel === "versions" ? "selected" : ""}
                onClick={() => selectPanel("versions")}
              >
                <History size={15} />
                <span>Versions</span>
              </button>
            </div>
            <div className="viewport-controls">
              <button
                className={`icon-button ${!mobile ? "selected" : ""}`}
                aria-label="Desktop preview"
                aria-pressed={!mobile}
                onClick={() => setMobile(false)}
              >
                <Monitor size={15} />
              </button>
              <button
                className={`icon-button ${mobile ? "selected" : ""}`}
                aria-label="Mobile preview"
                aria-pressed={mobile}
                onClick={() => setMobile(true)}
              >
                <Smartphone size={15} />
              </button>
              <span className="toolbar-divider" />
              <button
                className="icon-button"
                aria-label="Refresh preview"
                disabled={state?.preview?.status !== "ready"}
                onClick={() => void openPreview()}
              >
                <RotateCcw size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="Open preview in new tab"
                disabled={state?.preview?.status !== "ready"}
                onClick={() => void openPreview(true)}
              >
                <ArrowUpRight size={17} />
              </button>
            </div>
          </div>
          {panel === "versions" ? (
            versionsPanel
          ) : panel === "source" ? (
            <div className="source-panel">
              <div className="source-header">
                <span>{selectedVersion?.summary}</span>
                {selectedVersion && (
                  <a
                    className="text-button"
                    href={`/api/projects/${id}/versions/${selectedVersion.id}/export`}
                  >
                    <Download size={14} />
                    Download code
                  </a>
                )}
              </div>
              <div className="source-body">
                <nav aria-label="Source files">
                  {files.map((f) => (
                    <button
                      key={f.path}
                      className={filePath === f.path ? "active" : ""}
                      onClick={() => setFilePath(f.path)}
                    >
                      {f.path}
                    </button>
                  ))}
                </nav>
                <pre tabIndex={0}>
                  <code>
                    {files.find((f) => f.path === filePath)?.content ??
                      "Loading source…"}
                  </code>
                </pre>
              </div>
            </div>
          ) : (
            <div className="preview-canvas">
              <div className={`browser-frame ${mobile ? "mobile-frame" : ""}`}>
                <div className="browser-bar">
                  <span className="browser-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    {frameReady ? project?.name : "Your next version"}
                  </span>
                  <span className="browser-secure">PREVIEW</span>
                </div>
                <div className="frame-content">
                  <iframe
                    ref={frame}
                    name={`preview-${id}`}
                    title="Generated application preview"
                    sandbox="allow-scripts allow-same-origin allow-forms"
                    referrerPolicy="no-referrer"
                    className={frameReady ? "" : "hidden-frame"}
                  />
                  {!frameReady && (
                    <div className="preview-empty">
                      <div className="empty-symbol" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                      <span className="eyebrow">
                        {current
                          ? "YOUR IDEA, TAKING SHAPE"
                          : "A LITTLE SPACE FOR SOMETHING NEW"}
                      </span>
                      <h2>
                        {current
                          ? "Ready for a closer look."
                          : "This is where it comes to life."}
                      </h2>
                      <p>
                        {current
                          ? "Your checked and saved version is ready to open."
                          : "Describe your idea in chat. Once you approve the design, your working website will appear here."}
                      </p>
                      {current && (
                        <button
                          className="primary-button"
                          disabled={working}
                          onClick={() => void startPreview()}
                        >
                          {working ? (
                            <LoaderCircle size={15} className="spin" />
                          ) : (
                            <Play size={15} />
                          )}{" "}
                          {state?.preview?.status === "expired"
                            ? "Restart preview"
                            : "Start preview"}
                        </button>
                      )}
                      <span className="preview-caption">
                        {current
                          ? "A private preview. Publishing is a separate step."
                          : "DESIGN → APPROVE → BUILD → PREVIEW"}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              {state?.preview?.versionId &&
                current &&
                state.preview.versionId !== current.id && (
                  <button
                    className="update-preview"
                    disabled={working}
                    onClick={() => void startPreview()}
                  >
                    A newer version is saved. Open latest preview{" "}
                    <ArrowUpRight size={14} />
                  </button>
                )}
              {state?.preview?.status === "expired" && frameReady && (
                <button
                  className="update-preview"
                  disabled={working}
                  onClick={() => void startPreview()}
                >
                  Preview expired. Restart <RotateCcw size={14} />
                </button>
              )}
            </div>
          )}
          <footer className="build-strip">
            <span className={`status-dot ${working ? "working" : ""}`} />
            <span>{statusLabel(project?.status ?? "waiting")}</span>
            <span className="strip-right">
              {project?.deploymentUrl ? (
                <a
                  href={project.deploymentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View published site ↗
                </a>
              ) : (
                "PRIVATE UNTIL YOU PUBLISH"
              )}
            </span>
          </footer>
        </section>
        <section
          className={`mobile-versions mobile-${tab === "versions" ? "visible" : "hidden"}`}
        >
          {versionsPanel}
        </section>
      </div>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm === "publish"
            ? "Publish this version?"
            : "Restore this version?"
        }
        description={
          confirm === "publish"
            ? "This makes the selected version publicly available on its production URL."
            : "Restore creates a new checked version. Your published site will stay unchanged."
        }
      >
        <div className="release-summary">
          <span className="eyebrow">{project?.name}</span>
          <h3>{selectedVersion?.summary}</h3>
          <p>
            {selectedVersion &&
              new Date(selectedVersion.createdAt).toLocaleString()}
          </p>
          <code>{selectedVersion?.hash.slice(0, 12)}</code>
          {confirm === "publish" && (
            <p>
              Destination:{" "}
              {project?.deploymentUrl ?? `eveable-${id}.vercel.app`}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button className="text-button" onClick={() => setConfirm(null)}>
            Keep working
          </button>
          <button
            className="primary-button"
            disabled={working || !selectedVersion}
            onClick={() => {
              if (selectedVersion) {
                const input =
                  confirm === "publish"
                    ? {
                        kind: "publish",
                        versionId: selectedVersion.id,
                        hash: selectedVersion.hash,
                        confirmed: true,
                      }
                    : { kind: "restore", versionId: selectedVersion.id };
                setConfirm(null);
                void operate(input);
              }
            }}
          >
            {confirm === "publish" ? (
              <Upload size={15} />
            ) : (
              <RotateCcw size={15} />
            )}{" "}
            {confirm === "publish"
              ? "Publish publicly"
              : "Restore and validate"}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
