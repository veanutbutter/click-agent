import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import CodeMirror from "@uiw/react-codemirror";
import type { ReactElement } from "react";

import { extensionOf, formatCount } from "../format";
import type { OpenDocument } from "../hooks/useEditor";
import { IconBook, IconClose, IconFile, IconRefresh, IconSave, IconSpinner, IconTerminal } from "./Icons";

export interface EditorPaneProps {
  documents: OpenDocument[];
  active: OpenDocument | null;
  activePath: string | null;
  savingPath: string | null;
  onActivate(path: string): void;
  onClose(path: string): void;
  onChange(path: string, value: string): void;
  onSave(path: string): void;
  onReload(path: string): void;
}

const LANGUAGE_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  md: "Markdown",
  mdx: "Markdown",
  markdown: "Markdown",
  py: "Python",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  svg: "SVG",
  yml: "YAML",
  yaml: "YAML",
  sh: "Shell",
};

function languageLabel(filePath: string): string {
  return LANGUAGE_LABELS[extensionOf(filePath)] ?? "Plain text";
}

/**
 * Language support for a file, inferred from its extension. The return type is
 * intentionally inferred: every `@codemirror/lang-*` factory returns a
 * `LanguageSupport`, which is itself an `Extension`.
 */
function languageExtensions(filePath: string) {
  switch (extensionOf(filePath)) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: true })];
    case "json":
    case "jsonc":
      return [json()];
    case "md":
    case "mdx":
    case "markdown":
      return [markdown()];
    case "py":
      return [python()];
    case "html":
    case "htm":
      return [html()];
    case "css":
      return [css()];
    default:
      return [];
  }
}

function documentTint(filePath: string): string {
  const ext = extensionOf(filePath);
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "tab-ts";
  if (["json", "jsonc", "yaml", "yml"].includes(ext)) return "tab-data";
  if (["md", "mdx", "txt"].includes(ext)) return "tab-doc";
  if (["css", "scss", "html", "svg"].includes(ext)) return "tab-markup";
  return "";
}

function TabStrip({
  documents,
  activePath,
  onActivate,
  onClose,
}: Pick<EditorPaneProps, "documents" | "activePath" | "onActivate" | "onClose">): ReactElement {
  return (
    <div className="tab-strip" role="tablist" aria-label="Open files">
      {documents.map((document) => {
        const dirty = document.content !== document.saved;
        const isActive = document.path === activePath;
        return (
          <div key={document.path} className={`tab ${isActive ? "is-active" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`tab-button ${documentTint(document.path)}`}
              onClick={() => onActivate(document.path)}
              title={document.path}
            >
              {document.loading ? <IconSpinner className="tab-icon spinner" /> : <IconFile className="tab-icon" />}
              <span className="tab-title">{document.name}</span>
              {dirty ? <span className="tab-dirty" aria-label="Unsaved changes" title="Unsaved changes" /> : null}
            </button>
            <button
              type="button"
              className="tab-close"
              onClick={() => onClose(document.path)}
              aria-label={`Close ${document.name}`}
            >
              <IconClose />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EmptyEditor(): ReactElement {
  return (
    <div className="editor-empty">
      <div className="editor-empty-mark" aria-hidden="true">
        <IconTerminal className="empty-icon" />
      </div>
      <h2 className="empty-title">Nothing open</h2>
      <p className="empty-copy">
        Pick a file from the explorer, or describe what you need in the agent panel and let Click write it
        into the workspace.
      </p>
      <ul className="keymap">
        <li>
          <kbd>Ctrl</kbd>
          <kbd>S</kbd>
          <span>save the active file</span>
        </li>
        <li>
          <kbd>Shift</kbd>
          <kbd>Ctrl</kbd>
          <kbd>S</kbd>
          <span>save every changed file</span>
        </li>
        <li>
          <kbd>Enter</kbd>
          <span>send a prompt</span>
        </li>
        <li>
          <kbd>Shift</kbd>
          <kbd>Enter</kbd>
          <span>new line in the composer</span>
        </li>
      </ul>
    </div>
  );
}

export function EditorPane({
  documents,
  active,
  activePath,
  savingPath,
  onActivate,
  onClose,
  onChange,
  onSave,
  onReload,
}: EditorPaneProps): ReactElement {
  const dirty = active ? active.content !== active.saved : false;
  const saving = active !== null && savingPath === active.path;

  return (
    <section className="editor-pane" aria-label="Editor">
      {documents.length > 0 ? (
        <TabStrip
          documents={documents}
          activePath={activePath}
          onActivate={onActivate}
          onClose={onClose}
        />
      ) : null}

      {active ? (
        <>
          <div className="editor-toolbar">
            <span className="toolbar-path mono" title={active.path}>
              {active.path}
            </span>
            <span className="toolbar-spacer" />
            <span className={`toolbar-chip ${dirty ? "is-dirty" : ""}`}>
              {dirty ? "Unsaved changes" : "Saved"}
            </span>
            <span className="toolbar-chip muted">{languageLabel(active.path)}</span>
            <span className="toolbar-chip muted mono">{formatCount(active.content.length)} chars</span>
            <button
              type="button"
              className="btn btn-subtle"
              onClick={() => onReload(active.path)}
              disabled={dirty}
              title={dirty ? "Save or discard your changes before reloading from disk" : "Reload from disk"}
            >
              <IconRefresh className="btn-icon" />
              <span>Reload</span>
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onSave(active.path)}
              disabled={!dirty || saving}
              title={dirty ? "Write this file to disk (Ctrl+S)" : "No changes to save"}
            >
              {saving ? <IconSpinner className="btn-icon spinner" /> : <IconSave className="btn-icon" />}
              <span>{saving ? "Saving…" : "Save"}</span>
            </button>
          </div>

          {active.error ? (
            <div className="inline-error" role="alert">
              <IconBook className="btn-icon" />
              <span>{active.error}</span>
            </div>
          ) : null}

          <div className="editor-surface">
            <CodeMirror
              key={active.path}
              className="code-mirror"
              value={active.content}
              height="100%"
              theme="dark"
              editable={!active.loading}
              placeholder={active.loading ? "Loading…" : "This file is empty."}
              extensions={languageExtensions(active.path)}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                autocompletion: true,
                bracketMatching: true,
                closeBrackets: true,
                indentOnInput: true,
              }}
              onChange={(value: string) => onChange(active.path, value)}
            />
          </div>
        </>
      ) : (
        <EmptyEditor />
      )}
    </section>
  );
}
