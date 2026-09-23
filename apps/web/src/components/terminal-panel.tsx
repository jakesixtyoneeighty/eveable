"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  CornerDownLeft,
  LoaderCircle,
  Play,
  Square,
  TerminalSquare,
} from "lucide-react";
import { api, type Version } from "@/lib/client";

type TerminalState = {
  terminal: {
    id: string;
    versionId: string;
    status: string;
    expiresAt: string;
    commandCount: number;
    busy: boolean;
    error: string | null;
  } | null;
  commands: {
    id: string;
    command: string;
    status: string;
    output: string;
    exitCode: number | null;
    error: string | null;
    createdAt: string;
  }[];
};
const closed = ["closed", "failed", "expired"];
export function TerminalPanel({
  id,
  current,
  blocked,
}: {
  id: string;
  current?: Version;
  blocked: boolean;
}) {
  const [state, setState] = useState<TerminalState | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const [connected, setConnected] = useState(true);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const request = useRef<{ body: string; path: string; key: string } | null>(
    null,
  );
  const draft = useRef("");
  const log = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const terminal = state?.terminal;
  const active = !!terminal && !closed.includes(terminal.status);
  const expired = !!terminal && new Date(terminal.expiresAt).getTime() <= now;
  const ready =
    terminal?.status === "ready" && !terminal.busy && !expired && connected;
  const refresh = useCallback(async () => {
    const next = await api<TerminalState>(`/${id}/terminals`);
    setState(next);
    setNow(Date.now());
    setConnected(true);
  }, [id]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    async function poll() {
      try {
        const next = await api<TerminalState>(`/${id}/terminals`, {
          signal: abort.signal,
        });
        if (active) {
          setState(next);
          setNow(Date.now());
          setConnected(true);
        }
      } catch {
        if (active) setConnected(false);
      }
      if (active) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [id]);
  useEffect(() => {
    if (follow.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [state]);
  async function submit(path: string, payload: unknown) {
    const body = JSON.stringify(payload);
    if (request.current?.body !== body || request.current.path !== path)
      request.current = { body, path, key: crypto.randomUUID() };
    setSending(true);
    setError("");
    try {
      await api(path, {
        method: "POST",
        headers: { "idempotency-key": request.current.key },
        body,
      });
      request.current = null;
      if (path.endsWith("/commands")) {
        setInput("");
        setHistoryIndex(-1);
        draft.current = "";
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function stop() {
    if (!terminal) return;
    setStopping(true);
    setError("");
    try {
      const next = await api<TerminalState>(
        `/${id}/terminals/${terminal.id}/stop`,
        { method: "POST", body: "{}" },
      );
      setState(next);
      setNow(Date.now());
      request.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  }
  function run() {
    if (!ready || sending || !input.trim() || !terminal) return;
    follow.current = true;
    void submit(`/${id}/terminals/${terminal.id}/commands`, {
      command: input.trim(),
    });
  }
  const label = !terminal
    ? "No terminal open"
    : expired && active
      ? "Expired"
      : terminal.busy
        ? "Command running"
        : ((
            {
              queued: "Starting terminal",
              starting: "Installing dependencies",
              ready: "Ready",
              cleanup_required: "Retry Stop",
              stopping: "Stopping",
            } as Record<string, string>
          )[terminal.status] ?? terminal.status);
  return (
    <div className="terminal-panel">
      <div className="source-header terminal-header">
        <span>
          <span
            className={`status-dot ${terminal?.busy || terminal?.status === "starting" ? "working" : ""}`}
          />{" "}
          {label}
        </span>
        {active ? (
          <button
            className="text-button"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <Square size={13} />
            )}{" "}
            {terminal?.status === "cleanup_required"
              ? "Retry Stop"
              : "Stop terminal"}
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={!state || !current || blocked || sending || !connected}
            onClick={() =>
              current &&
              void submit(`/${id}/terminals`, { versionId: current.id })
            }
          >
            {sending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Play size={14} />
            )}{" "}
            {terminal ? "Start fresh terminal" : "Start terminal"}
          </button>
        )}
      </div>
      <div className="terminal-context">
        Temporary workspace from your saved code. File changes here stay
        separate from Code and Preview.
      </div>
      {terminal && current && terminal.versionId !== current.id && (
        <div className="code-notice">
          A newer version is saved. Stop this terminal, then start fresh to use
          the latest code.
        </div>
      )}
      {!connected && (
        <div className="code-notice" role="status">
          Reconnecting to terminal… Your command input is retained.
        </div>
      )}
      {error && (
        <div className="code-notice code-error" role="alert">
          {error}
        </div>
      )}
      {terminal?.error && (
        <div className="code-notice" role="status">
          {terminal.error}
        </div>
      )}
      <div
        className="terminal-log"
        aria-label="Terminal output"
        tabIndex={0}
        ref={log}
        onScroll={() => {
          const el = log.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!state ? (
          <p className="terminal-welcome">
            {connected ? "Loading terminal…" : "Waiting for connection…"}
          </p>
        ) : !state.commands.length ? (
          <div className="terminal-welcome">
            <TerminalSquare size={24} />
            <h3>A place to inspect and test.</h3>
            <p>
              Run shell commands against a temporary copy of your saved project.
              Dependencies are installed when the terminal starts.
            </p>
            <div className="terminal-examples">
              {["ls", "npm run typecheck", "npm run build"].map((command) => (
                <button key={command} onClick={() => setInput(command)}>
                  <CornerDownLeft size={12} />
                  {command}
                </button>
              ))}
            </div>
            <p className="terminal-hint">
              Commands run without interactive input or network access. Each
              starts in the project folder.
            </p>
          </div>
        ) : (
          state.commands.map((entry) => (
            <section
              key={entry.id}
              className="terminal-entry"
              aria-label={`Command: ${entry.command}`}
            >
              <div className="terminal-command">
                <span aria-hidden="true">$</span>
                <code>{entry.command}</code>
                <button
                  className="icon-button"
                  aria-label={`Reuse command: ${entry.command}`}
                  title="Use this command again"
                  onClick={() => {
                    setInput(entry.command);
                    setHistoryIndex(-1);
                  }}
                >
                  <ArrowUp size={13} />
                </button>
              </div>
              <pre>{entry.output}</pre>
              <div
                className={`terminal-result ${entry.status === "failed" ? "terminal-failed" : ""}`}
              >
                {entry.status === "queued" || entry.status === "running" ? (
                  <>
                    <LoaderCircle size={11} className="spin" />{" "}
                    {entry.status === "queued" ? "Queued" : "Running"}
                  </>
                ) : entry.exitCode !== null ? (
                  `Exited with code ${entry.exitCode}`
                ) : (
                  entry.status.replaceAll("_", " ")
                )}
              </div>
              {entry.error && (
                <p className="terminal-command-error">{entry.error}</p>
              )}
            </section>
          ))
        )}
      </div>
      <form
        className="terminal-input"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <span aria-hidden="true">$</span>
        <input
          aria-label="Terminal command"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={input}
          maxLength={4000}
          placeholder="Enter a command…"
          onChange={(e) => {
            setInput(e.target.value);
            setHistoryIndex(-1);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            const commands = state?.commands ?? [];
            if (!commands.length) return;
            e.preventDefault();
            if (historyIndex === -1) draft.current = input;
            const next =
              e.key === "ArrowUp"
                ? Math.min(historyIndex + 1, commands.length - 1)
                : Math.max(historyIndex - 1, -1);
            setHistoryIndex(next);
            setInput(
              next === -1
                ? draft.current
                : commands[commands.length - next - 1].command,
            );
          }}
        />
        <button
          type="submit"
          className="primary-button"
          disabled={!ready || sending || stopping || !input.trim()}
        >
          {sending ? (
            <LoaderCircle className="spin" size={14} />
          ) : (
            <CornerDownLeft size={14} />
          )}
          Run
        </button>
      </form>
      <div className="code-footer">
        <span>
          {terminal
            ? `${terminal.commandCount} / 20 commands`
            : "SAVED VERSION ONLY"}
        </span>
        <span>2 MIN / COMMAND · 15 MIN SESSION</span>
      </div>
    </div>
  );
}
