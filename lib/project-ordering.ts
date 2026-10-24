import { comparableProjectPath } from "./comparable-path";
import type { ManagedProject, SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

// ============================================================================
// Pure ordering/grouping helpers shared between the sidebar and unit tests.
// All keys are canonical projectRoot paths (worktrees collapse into their main
// repo via resolveProject), so worktree sessions group under their project.
//
// The project list is ordered by when each project was added (addedAt desc =
// most recently added first), NOT by session activity: activity changes on
// every session refresh (agent runs, message edits, unread transitions) and
// would make project rows jump around constantly. Registration order is
// stable — it only changes when the user explicitly adds a project.
// Session-discovered projects (no addedAt) follow the registered ones in
// path order, which is also stable.
// ============================================================================

/** Sort projects by most-recently-added (addedAt desc), then by path for a
 *  deterministic order. Projects without addedAt (session-discovered) always
 *  sort below registered ones. The order never depends on session activity,
 *  so project rows stay put while sessions refresh. */
export function sortManagedProjects(projects: ManagedProject[]): ManagedProject[] {
  return [...projects].sort((a, b) => {
    const aManual = a.sortOrder !== undefined;
    const bManual = b.sortOrder !== undefined;
    if (aManual !== bManual) return aManual ? -1 : 1;
    if (aManual && bManual && a.sortOrder !== b.sortOrder) return a.sortOrder! - b.sortOrder!;
    const aHas = a.addedAt !== undefined;
    const bHas = b.addedAt !== undefined;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas) {
      const byAdded = b.addedAt!.localeCompare(a.addedAt!);
      if (byAdded !== 0) return byAdded;
    }
    return a.path.localeCompare(b.path);
  });
}

/** Running/unread/exit session counts per project, for the activity indicators
 *  on project rows. Keys are the case-folded comparable form of the projectRoot
 *  so casing-only differences (Windows/NTFS) still resolve — callers must
 *  look up with comparableProjectPath(project.path). */
export function projectActivityCounts(
  sessions: SessionInfo[],
  runningIds: Iterable<string>,
  unreadIds: Iterable<string>,
  exitedIds: Iterable<string> = [],
): Map<string, { running: number; unread: number; exited: number }> {
  const running = new Set(runningIds);
  const unread = new Set(unreadIds);
  const exited = new Set(exitedIds);
  const result = new Map<string, { running: number; unread: number; exited: number }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    const folded = comparableProjectPath(session.projectKey ?? key);
    const current = result.get(folded) ?? { running: 0, unread: 0, exited: 0 };
    if (running.has(session.id)) current.running += 1;
    if (unread.has(session.id)) current.unread += 1;
    if (exited.has(session.id)) current.exited += 1;
    result.set(folded, current);
  }
  return result;
}

/** Group sessions under their project. Every project in `projects` gets an
 *  entry (possibly empty) so empty managed projects render their empty state.
 *  Buckets are keyed by the exact project path for callers; sessions are
 *  matched through a case-folded lookup (Windows/NTFS is case-insensitive and
 *  session-file cwds can carry different casing than the registered path), so
 *  casing-only differences land in the right bucket instead of silently
 *  dropping the session from the sidebar. */
export function groupSessionsByProject(
  projects: ManagedProject[],
  sessions: SessionInfo[],
): Map<string, SessionInfo[]> {
  const grouped = new Map<string, SessionInfo[]>();
  const bucketByKey = new Map<string, SessionInfo[]>();
  for (const project of projects) {
    const bucket: SessionInfo[] = [];
    grouped.set(project.path, bucket);
    bucketByKey.set(comparableProjectPath(project.path), bucket);
  }
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    if (!key) continue;
    // workspaceKeyOf already prefers projectKey, so this IS the session's
    // key; bucketByKey covers every registered project under its case-folded
    // path, and an exact-case fallback here could only hit when the folded
    // lookup already did — otherwise it silently dropped the session.
    const bucket = bucketByKey.get(comparableProjectPath(key));
    if (bucket) bucket.push(session);
  }
  return grouped;
}

// ============================================================================
// Temporary/test workspace classification.
// ============================================================================

/** True when a project root is an OS temp directory or an automatic test
 * fixture that should fold into the sidebar's single consolidated "temporary"
 * group instead of standing alone. Conservative: only temp roots, degenerate
 * cwds, and the openclaw test-artifact convention (`oc-wkr`/`oc-plg`) match —
 * real user directories are never classified. Sessions are never dropped, only
 * grouped together, so this can never delete or hide anything. */
export function isTemporaryProjectPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const p = path.replace(/\\/g, "/");
  if (p === "." || p === "/" || p === "//" || p === "null") return true;
  return (
    /^\/(private\/)?(var\/)?tmp(\/|$)/i.test(p)
    || /\/var\/folders\/[^/]+\/[^/]+\/T(\/|$)/i.test(p)
    || /oc-(wkr|plg)(\/|-|$)/i.test(p)
  );
}

/** Top-level category a workspace is bucketed under in the sidebar. Workspaces
 * are rolled up by their top folder so the list reads as a handful of clean
 * sections instead of dozens of near-empty project rows. */
export type WorkspaceCategory = "cloud" | "homelab" | "projects" | "other" | "temp";

/** Display order: real folders first, then the catch-alls, temp last. */
export const WORKSPACE_CATEGORY_ORDER: readonly WorkspaceCategory[] = [
  "cloud",
  "homelab",
  "projects",
  "other",
  "temp",
];

/** Classify a canonical project root into its sidebar category. Temporary/test
 * paths win; otherwise the top-level `~/Cloud`, `~/homelab*`, or `~/Projects`
 * folder selects the bucket, and anything else is `other`. */
export function workspaceCategory(path: string | null | undefined): WorkspaceCategory {
  if (isTemporaryProjectPath(path)) return "temp";
  const p = (path ?? "").replace(/\\/g, "/");
  if (/(^|\/)cloud(\/|$)/i.test(p)) return "cloud";
  if (/(^|\/)homelab([/_-]|$)/i.test(p)) return "homelab";
  if (/(^|\/)projects(\/|$)/i.test(p)) return "projects";
  return "other";
}

/** Sidebar-only identity: never publish this bucket as a runnable cwd. */
export const TEMP_WORKSPACES_GROUP_PATH = "__omp-temp-workspaces__";

export interface WorkspaceEntry {
  project: ManagedProject;
  sessions: SessionInfo[];
  synthetic?: boolean;
  category: WorkspaceCategory;
}

/** Derive the canonical, unfiltered sidebar rows and new-chat choices together.
 * Projects arrive in their stable managed order (including any pending-session
 * order freeze); category grouping preserves that order within each section.
 * Only empty temporary fixtures fold into a synthetic row. A temporary path
 * with a real conversation remains an ordinary workspace with folder controls.
 * Neither projects nor transcripts are mutated. */
export function deriveWorkspaceEntries(
  projects: ManagedProject[],
  sessions: SessionInfo[],
  temporaryLabel: string,
): { entries: WorkspaceEntry[]; workspaceOptions: ManagedProject[] } {
  const sessionsByProject = groupSessionsByProject(projects, sessions);
  const entries: WorkspaceEntry[] = [];
  const temporarySessions: SessionInfo[] = [];
  for (const project of projects) {
    const list = sessionsByProject.get(project.path) ?? [];
    if (isTemporaryProjectPath(project.path) && list.every((session) => session.messageCount === 0)) {
      temporarySessions.push(...list);
    } else {
      entries.push({ project, sessions: list, category: workspaceCategory(project.path) });
    }
  }
  if (temporarySessions.length > 0) {
    entries.push({
      project: { path: TEMP_WORKSPACES_GROUP_PATH, alias: temporaryLabel },
      sessions: temporarySessions,
      synthetic: true,
      category: "temp",
    });
  }
  entries.sort((a, b) => WORKSPACE_CATEGORY_ORDER.indexOf(a.category) - WORKSPACE_CATEGORY_ORDER.indexOf(b.category));
  return {
    entries,
    workspaceOptions: entries.filter((entry) => !entry.synthetic).map((entry) => entry.project),
  };
}

/** Apply display-only filters after deriving identities, so searching or
 * showing running sessions cannot change new-chat choices or turn a real
 * temporary workspace into a synthetic fixture bucket. */
export function filterWorkspaceEntries(
  entries: WorkspaceEntry[],
  searchQuery: string,
  runningOnly: boolean,
  runningSessionIds: ReadonlySet<string>,
  projectLabel: (path: string) => string,
): WorkspaceEntry[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query && !runningOnly) return entries;
  const filtered: WorkspaceEntry[] = [];
  for (const entry of entries) {
    let sessions = entry.sessions;
    if (runningOnly) sessions = sessions.filter((session) => runningSessionIds.has(session.id));
    if (query) {
      sessions = sessions.filter((session) => (session.name ?? "").toLowerCase().includes(query) || session.firstMessage.toLowerCase().includes(query));
    }
    if (sessions.length === 0) {
      if (entry.synthetic || runningOnly) continue;
      // Alias/label matches keep an empty real workspace discoverable.
      if (query && !projectLabel(entry.project.path).toLowerCase().includes(query)
        && !(entry.project.alias ?? "").toLowerCase().includes(query)) continue;
    }
    filtered.push({ ...entry, sessions });
  }
  return filtered;
}
