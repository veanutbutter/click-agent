import { promises as fs } from "node:fs";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * A directory the agent is confined to. Every path the agent supplies is
 * resolved through {@link resolve}, which rejects escapes from the root —
 * including via symlink-free traversal and absolute paths outside the root.
 */
export class Workspace {
  readonly root: string;

  /**
   * Whether reads may reach outside the workspace. Writes are always confined.
   *
   * Reading outside is a normal need — a config, a sibling repo, a dependency —
   * and the user is the one driving the agent. Writing outside is not: that is
   * how an agent damages a machine, so it stays confined to the root.
   */
  allowOutsideReads = false;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolve a user/agent-supplied path, rejecting anything outside the root. */
  resolve(candidate: string): string {
    const absolute = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(this.root, candidate);
    if (!isInside(this.root, absolute)) {
      throw new WorkspaceError(
        `Path "${candidate}" is outside the workspace root (${this.root})`,
      );
    }
    return absolute;
  }

  /**
   * Resolve a path for reading. Outside the root this is allowed when
   * {@link allowOutsideReads} is set, and relative paths still resolve against
   * the root so the common case is unchanged.
   */
  resolveRead(candidate: string): string {
    if (!this.allowOutsideReads) return this.resolve(candidate);
    return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(this.root, candidate);
  }

  /** Display path: workspace-relative when inside, absolute when outside. */
  display(absolute: string): string {
    return isInside(this.root, absolute) ? this.relative(absolute) : absolute;
  }

  /** Workspace-relative POSIX-ish path for display. */
  relative(absolute: string): string {
    const rel = path.relative(this.root, absolute);
    return rel.split(path.sep).join("/");
  }

  async exists(candidate: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(candidate));
      return true;
    } catch {
      return false;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedRoot === normalizedTarget) return true;
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return normalizedTarget.startsWith(withSep);
}
