import type { SessionInfo } from "@/lib/types";
import { comparableProjectPath } from "@/lib/comparable-path";
interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}
/** The active Git workspace's worktrees plus the actions that change them
 *  (owned by SessionSidebar, rendered by the file panel's Worktrees tab). */
interface WorktreeContext {
  projectRoot: string;
  worktrees: WorktreeEntry[];
  /** Path of the worktree the workspace currently points at. */
  currentPath: string;
  select(path: string): void;
  /** Creates the branch's worktree and selects it; rejects with an Error whose message is user-facing. */
  create(branch: string): Promise<void>;
  /** Resolves "dirty" when the worktree has uncommitted changes and force was false; rejects with a user-facing Error otherwise. */
  remove(path: string, force: boolean): Promise<"removed" | "dirty">;
}
/** Normalize a repository/project path for use as a Git-state map key. The
 *  same physical repo may be reached via different path spellings (forward /
 *  back slashes, drive-letter casing); folding them makes distinct spellings
 *  resolve to one shared Git context, while genuinely different repos stay
 *  separate. */
function normalizeProjectKey(value: string): string {
  // Clip trailing separators and unify separators. Fold case when the path is
  // Windows-style (drive-letter rooted or backslash-y) so Drive:\ vs C:\ and
  // path casing variants map to the same repository, while preserving
  // case-sensitivity for POSIX paths (client has no process.platform).
  const isWindowsPath = /^[a-zA-Z]:/.test(value) || value.includes("\\");
  const normalized = value.replace(/[\/]+$/, "").replace(/\\/g, "/");
  return isWindowsPath ? normalized.toLowerCase() : normalized;
}
// Bounded retry window for restoring a brand-new session from its URL before
// omp flushes the JSONL (typically appears within a second or two of the
// first prompt, so 8 × 1s covers it without hanging a dead link forever).
const INITIAL_RESTORE_RETRY_MS = 1000;
const INITIAL_RESTORE_MAX_ATTEMPTS = 8;
const UNREAD_SESSIONS_STORAGE_KEY = "omp-web:unread-session-ids";

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}
const EXPANDED_PROJECTS_STORAGE_KEY = "omp-web:expanded-workspaces";

/** Shared empty set for the no-stored-expansion default (never mutated). */
const EMPTY_PROJECT_SET: ReadonlySet<string> = new Set();

/** Persisted logical workspace IDs. Returns null when nothing was stored —
 *  the sidebar then defaults to expanding only the active workspace. */
function loadExpandedProjects(): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
    }
    return null;
  } catch {
    return null;
  }
}

function saveExpandedProjects(paths: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...paths]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}
/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/** Final folder name of a project path, portable across / and \ separators. */
function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}
function formatRelativeTime(value: string, _locale: string, now: number): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  // Native IDs can repeat in imported/test workspaces. Keep every file rather
  // than letting a Map overwrite earlier sessions; ambiguous parents stay roots.
  const nodes = sessions.map((session) => ({ session, children: [] as SessionTreeNode[] }));
  const byId = new Map<string, SessionTreeNode | null>();
  for (const node of nodes) {
    const id = node.session.id;
    byId.set(id, byId.has(id) ? null : node);
  }

  const roots: SessionTreeNode[] = [];
  for (const node of nodes) {
    const parentId = node.session.parentSessionId;
    const parent = parentId ? byId.get(parentId) : null;
    let ancestor = parent;
    const visited = new Set<SessionTreeNode>([node]);
    let cyclic = false;
    while (ancestor) {
      if (visited.has(ancestor)) {
        cyclic = true;
        break;
      }
      visited.add(ancestor);
      ancestor = ancestor.session.parentSessionId
        ? byId.get(ancestor.session.parentSessionId)
        : null;
    }
    if (parent && !cyclic) parent.children.push(node);
    else roots.push(node);
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
export {
  EMPTY_PROJECT_SET,
  EXPANDED_PROJECTS_STORAGE_KEY,
  INITIAL_RESTORE_MAX_ATTEMPTS,
  INITIAL_RESTORE_RETRY_MS,
  UNREAD_SESSIONS_STORAGE_KEY,
  buildSessionTree,
  displayCwd,
  formatRelativeTime,
  loadExpandedProjects,
  loadUnreadSessionIds,
  normalizeProjectKey,
  projectLabel,
  saveExpandedProjects,
  saveUnreadSessionIds,
  type SessionTreeNode,
  type WorktreeContext,
  type WorktreeEntry,
  type WorktreeState,
};
