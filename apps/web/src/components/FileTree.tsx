import type { FileNode } from "@click/bridge";
import type { ReactElement } from "react";
import { useState } from "react";

import { extensionOf } from "../format";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconSpinner,
} from "./Icons";

export interface FileTreeProps {
  rootPath: string;
  /** Directory listing cache keyed by directory path. */
  entries: Record<string, FileNode[]>;
  loadingDirs: Record<string, boolean>;
  activePath: string | null;
  onOpenFile(path: string): void;
  onLoadDir(path: string): void;
}

/** Everything the recursive rows share; passed down instead of via context. */
interface TreeContext {
  entries: Record<string, FileNode[]>;
  loadingDirs: Record<string, boolean>;
  activePath: string | null;
  expanded: Record<string, boolean>;
  onOpenFile(path: string): void;
  onLoadDir(path: string): void;
  onToggle(path: string): void;
}

const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "rb", "sh"]);
const MARKUP_EXTENSIONS = new Set(["css", "scss", "html", "svg", "xml", "vue", "svelte"]);
const DATA_EXTENSIONS = new Set(["json", "jsonc", "yaml", "yml", "toml"]);

function fileTintClass(name: string): string {
  const ext = extensionOf(name);
  if (CODE_EXTENSIONS.has(ext)) return "ft-code";
  if (MARKUP_EXTENSIONS.has(ext)) return "ft-markup";
  if (DATA_EXTENSIONS.has(ext)) return "ft-data";
  if (ext === "md" || ext === "mdx" || ext === "txt") return "ft-doc";
  return "";
}

function indent(depth: number, base: number): string {
  return `${depth * 14 + base}px`;
}

function TreeLevel({ ctx, dirPath, depth }: { ctx: TreeContext; dirPath: string; depth: number }): ReactElement | null {
  const children = ctx.entries[dirPath];

  if (!children) {
    if (ctx.loadingDirs[dirPath] !== true) return null;
    return (
      <li className="tree-status" style={{ paddingLeft: indent(depth, 22) }}>
        <IconSpinner className="icon spinner" />
        <span className="dim">Loading…</span>
      </li>
    );
  }

  if (children.length === 0) {
    return (
      <li className="tree-status dim" style={{ paddingLeft: indent(depth, 22) }}>
        empty
      </li>
    );
  }

  return (
    <>
      {children.map((node) =>
        node.type === "directory" ? (
          <DirectoryRow key={node.path} ctx={ctx} node={node} depth={depth} />
        ) : (
          <li key={node.path}>
            <button
              type="button"
              className={`tree-row tree-file ${node.path === ctx.activePath ? "is-active" : ""}`}
              style={{ paddingLeft: indent(depth, 18) }}
              onClick={() => ctx.onOpenFile(node.path)}
              title={node.path}
              aria-current={node.path === ctx.activePath ? "true" : undefined}
            >
              <IconFile className={`icon tree-file-icon ${fileTintClass(node.name)}`} />
              <span className="tree-label">{node.name}</span>
            </button>
          </li>
        ),
      )}
    </>
  );
}

function DirectoryRow({
  ctx,
  node,
  depth,
}: {
  ctx: TreeContext;
  node: FileNode;
  depth: number;
}): ReactElement {
  const isOpen = ctx.expanded[node.path] === true;

  return (
    <li>
      <button
        type="button"
        className="tree-row tree-folder"
        style={{ paddingLeft: indent(depth, 4) }}
        onClick={() => ctx.onToggle(node.path)}
        aria-expanded={isOpen}
        title={node.path}
      >
        {isOpen ? (
          <IconChevronDown className="icon tree-caret" />
        ) : (
          <IconChevronRight className="icon tree-caret" />
        )}
        {isOpen ? (
          <IconFolderOpen className="icon tree-folder-icon" />
        ) : (
          <IconFolder className="icon tree-folder-icon" />
        )}
        <span className="tree-label">{node.name}</span>
      </button>
      {isOpen ? (
        <ul className="tree-children">
          <TreeLevel ctx={ctx} dirPath={node.path} depth={depth + 1} />
        </ul>
      ) : null}
    </li>
  );
}

/** Lazy, recursive explorer: a directory is only listed the first time it opens. */
export function FileTree({
  rootPath,
  entries,
  loadingDirs,
  activePath,
  onOpenFile,
  onLoadDir,
}: FileTreeProps): ReactElement {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (path: string): void => {
    const isOpen = expanded[path] === true;
    setExpanded((prev) => ({ ...prev, [path]: !isOpen }));
    if (!isOpen) onLoadDir(path);
  };

  const ctx: TreeContext = { entries, loadingDirs, activePath, expanded, onOpenFile, onLoadDir, onToggle: toggle };

  return (
    <ul className="file-tree">
      <TreeLevel ctx={ctx} dirPath={rootPath} depth={0} />
    </ul>
  );
}
