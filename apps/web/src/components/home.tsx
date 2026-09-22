"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import {
  ArrowUpRight,
  ArrowUp,
  Search,
  Plus,
  Archive,
  RotateCcw,
  Pencil,
  Check,
} from "lucide-react";
import { api, statusLabel, type ProjectSummary } from "@/lib/client";
import { Dialog } from "./ui/dialog";
export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Eveable home">
      <span className="brand-mark" aria-hidden="true">
        e
      </span>
      eveable<span className="beta">STUDIO</span>
    </Link>
  );
}
export default function Home() {
  const router = useRouter();
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState(false);
  const [rename, setRename] = useState<ProjectSummary | null>(null);
  const [name, setName] = useState("");
  async function refresh() {
    try {
      setItems(await api<ProjectSummary[]>(""));
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void api<ProjectSummary[]>("")
      .then(setItems)
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);
  async function create() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const p = await api<{ id: string }>("", {
        method: "POST",
        body: JSON.stringify({
          id: crypto.randomUUID(),
          name: prompt.trim().split(/\s+/).slice(0, 8).join(" "),
        }),
      });
      await api(`/${p.id}/operations`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ kind: "message", message: prompt }),
      });
      router.push(`/projects/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      void refresh();
    }
  }
  async function patch(id: string, value: unknown) {
    try {
      await api(`/${id}`, { method: "PATCH", body: JSON.stringify(value) });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const filtered = items.filter(
    (p) =>
      p.archived === archived &&
      p.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="home">
      <header className="topbar">
        <Brand />
        <div className="account">
          <span className="private-label">
            <span />
            Private workspace
          </span>
          <UserButton />
        </div>
      </header>
      <main className="home-main">
        <div className="eyebrow">
          <span className="tiny-cross">+</span> FROM FIRST THOUGHT TO FIRST
          VERSION
        </div>
        <h1>
          Make room
          <br />
          for your <em>next idea.</em>
        </h1>
        <p className="intro">
          Describe a website. Shape the design together.
          <br />
          Build it, try it, and publish when it feels right.
        </p>
        <form
          className="idea-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="sr-only" htmlFor="idea">
            Describe your project
          </label>
          <textarea
            id="idea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A website for a small architecture studio, with a project gallery and a quiet, editorial feel…"
            rows={3}
            maxLength={16000}
          />
          <div className="composer-footer">
            <span>Next.js websites · Design approval before building</span>
            <button
              className="send-button"
              disabled={!prompt.trim() || busy}
              aria-label="Create project"
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </form>
        <div className="under-composer">
          <span className="line" />
          <span>YOUR IDEAS STAY YOURS</span>
          <span className="line" />
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <section className="project-library">
          <div className="section-heading">
            <div>
              <span className="eyebrow">THE WORKBENCH</span>
              <h2>
                Your projects{" "}
                <small>{filtered.length.toString().padStart(2, "0")}</small>
              </h2>
            </div>
            <div className="library-controls">
              <label className="search">
                <Search size={15} />
                <input
                  aria-label="Search projects"
                  placeholder="Find a project"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <button
                className="text-button"
                onClick={() => setArchived(!archived)}
              >
                {archived ? "Recent" : "Archived"}
              </button>
            </div>
          </div>
          {!loaded ? (
            <p className="empty">Loading your projects…</p>
          ) : !filtered.length ? (
            <div className="library-empty">
              <Plus size={24} />
              <p>
                {search
                  ? "No projects match your search."
                  : archived
                    ? "No archived projects."
                    : "Your first project starts with an idea above."}
              </p>
            </div>
          ) : (
            <div className="project-list">
              {filtered.map((p, i) => (
                <div className="project-row" key={p.id}>
                  <span className="project-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <Link href={`/projects/${p.id}`} className="project-title">
                    <strong>{p.name}</strong>
                    <span>{statusLabel(p.status)}</span>
                  </Link>
                  <span className="project-date">
                    {new Date(p.updatedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`Rename ${p.name}`}
                    onClick={() => {
                      setRename(p);
                      setName(p.name);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`${p.archived ? "Unarchive" : "Archive"} ${p.name}`}
                    onClick={() => void patch(p.id, { archived: !p.archived })}
                  >
                    {p.archived ? (
                      <RotateCcw size={15} />
                    ) : (
                      <Archive size={15} />
                    )}
                  </button>
                  <Link
                    href={`/projects/${p.id}`}
                    className="icon-button"
                    aria-label={`Open ${p.name}`}
                  >
                    <ArrowUpRight size={20} />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
      <footer className="home-footer">
        <span>Ideas deserve to be made.</span>
        <span>EVEABLE / 01</span>
      </footer>
      <Dialog
        open={!!rename}
        onOpenChange={(o) => {
          if (!o) setRename(null);
        }}
        title="Rename project"
        description="Choose a name you will recognize later."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (rename) {
              void patch(rename.id, { name });
              setRename(null);
            }
          }}
        >
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            aria-label="Project name"
          />
          <button
            className="primary-button"
            type="submit"
            disabled={!name.trim()}
          >
            <Check size={15} />
            Save name
          </button>
        </form>
      </Dialog>
    </div>
  );
}
