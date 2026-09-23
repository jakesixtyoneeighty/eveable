"use client";
import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";

function language(path: string) {
  if (/\.[cm]?[jt]sx?$/.test(path))
    return javascript({
      typescript: /\.[cm]?tsx?$/.test(path),
      jsx: /x$/.test(path),
    });
  if (/\.css$/.test(path)) return css();
  if (/\.json$/.test(path)) return json();
  if (/\.html$/.test(path)) return html();
  if (/\.md$/.test(path)) return markdown();
  return [];
}

export default function CodeEditor({
  documentId,
  path,
  content,
  readOnly,
  onChange,
}: {
  documentId: string;
  path: string;
  content: string;
  readOnly: boolean;
  onChange: (content: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const editable = useRef(new Compartment());
  const change = useRef(onChange);
  const initial = useRef({ content, readOnly });
  useEffect(() => {
    change.current = onChange;
    initial.current = { content, readOnly };
  }, [onChange, content, readOnly]);
  useEffect(() => {
    if (!host.current) return;
    const cache = states.current;
    const state =
      cache.get(documentId) ??
      EditorState.create({
        doc: initial.current.content,
        extensions: [
          basicSetup,
          language(path),
          editable.current.of(
            EditorState.readOnly.of(initial.current.readOnly),
          ),
          EditorView.contentAttributes.of({
            "aria-label": `Code for ${path}`,
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "#fcfdfb",
              fontSize: "12px",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily:
                "var(--font-geist-mono, ui-monospace), SFMono-Regular, Menlo, monospace",
              lineHeight: "1.7",
            },
            ".cm-content": { padding: "16px 0" },
            ".cm-gutters": {
              backgroundColor: "#f5f7f1",
              color: "#859084",
              borderRight: "1px solid #e4e9de",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "#edf2e9",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-search": { fontFamily: "inherit" },
          }),
        ],
      });
    const view = new EditorView({ state, parent: host.current });
    view.dispatch({
      effects: editable.current.reconfigure(
        EditorState.readOnly.of(initial.current.readOnly),
      ),
    });
    editor.current = view;
    return () => {
      cache.set(documentId, view.state);
      view.destroy();
      editor.current = null;
    };
  }, [documentId, path]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);
  return <div className="code-editor" ref={host} />;
}
