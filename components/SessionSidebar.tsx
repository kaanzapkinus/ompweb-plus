"use client";

import { memo, useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo, useDeferredValue } from "react";
import type { ExitedRpcSession, ManagedProject, ProjectLaunchConfig, SessionInfo, Workspace, WorkspacesRegistry } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProjectLaunchConfigDialog } from "./ProjectLaunchConfigDialog";
import { ProviderUsageBar } from "./ProviderUsageBar";
import { Tooltip } from "./ui/primitives";
import { toast } from "./ui/toast";
import { clearLastOpenSession, setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { groupWorkspaceSessions } from "@/lib/workspace-view";
import { comparableProjectPath } from "@/lib/comparable-path";
import { Archive, ArrowLeft, ArrowRight, Check, ChevronRight, FileUp, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, X } from "lucide-react";
import { publishSessionsChanged } from "@/lib/session-change-bus";
import { openEventStream } from "@/lib/event-stream";
import {
  EMPTY_PROJECT_SET,
  INITIAL_RESTORE_MAX_ATTEMPTS,
  INITIAL_RESTORE_RETRY_MS,
  buildSessionTree,
  loadExpandedProjects,
  loadUnreadSessionIds,
  normalizeProjectKey,
  saveExpandedProjects,
  saveUnreadSessionIds,
  type WorktreeContext,
  type WorktreeEntry,
  type WorktreeState,
} from "./SessionSidebar-helpers";
import { OmpWebTitle, SIDEBAR_BUTTON_TRANSITION, SidebarIconButton } from "./SessionSidebar-chrome";
import { WorkspaceRow } from "./SessionSidebar-rows";
import { requestWorkspace, WorkspaceNameDialog } from "./SessionSidebar-workspaces";

/** Deadline for one /api/sessions fetch. A wedged-but-listening server never
 * answers; without this the initial spinner would pend forever. */
const SESSIONS_FETCH_TIMEOUT_MS = 15_000;

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  /** The active session can exist in memory before its JSONL file is flushed. */
  optimisticSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string, workspaceId?: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  selectedWorkspaceId?: string | null;
  optimisticWorkspaceId?: string | null;
  onWorkspaceOptionsChange?: (workspaces: Workspace[], selectedWorkspaceId: string | null) => void;
  /** The active Git workspace's worktrees and actions (null when the active
   *  workspace is not a Git top-level repo); rendered by the file panel. */
  onWorktreeContextChange?: (ctx: WorktreeContext | null) => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  /** Shows the provider usage bar above Settings; toggle lives in Settings. */
  usageVisible?: boolean;
  /** Opens the app settings (pinned sidebar footer row). */
  onOpenSettings?: () => void;
  /** True when an omp/ompweb update is available — shows a badge on the gear. */
  updateAvailable?: boolean;
  /** Opens the archived sessions browser. */
  onOpenArchive?: () => void;
  /** In-app back/forward over visited chat views (sidebar header buttons). */
  navigation?: {
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
    /** Platform shortcut label for the tooltip, e.g. "⌘[" / "Alt+←". */
    backShortcut: string;
    forwardShortcut: string;
  };
  /** True when settings full-page view is currently open. */
  settingsOpen?: boolean;
  /** Mobile full-screen drawer only: shows a top-left close control. */
  onClose?: () => void;
}







export const SessionSidebar = memo(function SessionSidebar({ selectedSessionId, optimisticSession, optimisticWorkspaceId, selectedWorkspaceId: selectedWorkspaceIdProp, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onWorkspaceOptionsChange, onWorktreeContextChange, addProjectOpen, setAddProjectOpen, usageVisible = true, onOpenSettings, onOpenArchive, navigation, updateAvailable, settingsOpen = false, onClose }: Props) {


  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  // Managed + session-discovered projects (server-merged, hidden excluded).
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // Add-project picker state.
  const [addProjectBusy, setAddProjectBusy] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  // Per-project expansion, persisted to localStorage (null = nothing stored).
  const [expandedProjects, setExpandedProjects] = useState<Set<string> | null>(() => loadExpandedProjects());
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [pendingWorkspace, setPendingWorkspace] = useState<{ cwd: string; launchConfig?: ProjectLaunchConfig } | null>(null);
  const [launchConfigProject, setLaunchConfigProject] = useState<ManagedProject | null>(null);
  // Worktree/branch/Git state is scoped per repository. It is cached in a
  // map keyed by the normalized repository root so switching workspaces never
  // leaks one project's branch/worktree data into another's UI (each project
  // keeps its own loaded Git state; a late async response for a previous repo
  // only updates that repo's entry, never the active one).
  const [worktreeStateByProject, setWorktreeStateByProject] = useState<Record<string, WorktreeState>>({});
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [runningSessionCwds, setRunningSessionCwds] = useState<Record<string, string>>({});
  const [exitedSessions, setExitedSessions] = useState<Map<string, ExitedRpcSession>>(() => new Map());
  const knownRunningCwdsRef = useRef<Map<string, string>>(new Map());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Relative session times must age while the sidebar stays open; one shared
  // minute clock avoids a timer per session row.
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  // Client-side workspace/session filtering (Workspaces header controls).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Once the SSE stream has delivered a frame it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const sseAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionsEtagRef = useRef<string | null>(null);
  const sessionsAbortRef = useRef<AbortController | null>(null);
  // Set once the first /api/sessions fetch settles (success OR failure) so the
  // initial-restore effect can stop waiting on a load that never yields rows.
  const initialLoadedRef = useRef(false);
  const loadSessions = useCallback(async (showLoading = false) => {
    sessionsAbortRef.current?.abort();
    const controller = new AbortController();
    sessionsAbortRef.current = controller;
    // A wedged-but-listening server (the long-idle failure mode) accepts the
    // TCP connection and never answers: without a deadline the fetch pends
    // forever and the sidebar shows its initial spinner indefinitely. Abort
    // with a TimeoutError so the catch surfaces an error and the
    // visibility/online recovery below can retry later.
    const timeout = setTimeout(() => controller.abort(new DOMException("Session list request timed out", "TimeoutError")), SESSIONS_FETCH_TIMEOUT_MS);
    try {
      if (showLoading) setLoading(true);
      const headers: Record<string, string> = {};
      if (sessionsEtagRef.current) headers["If-None-Match"] = sessionsEtagRef.current;
      const res = await fetch("/api/sessions", { headers, signal: controller.signal });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get("ETag");
      if (etag) sessionsEtagRef.current = etag;
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; runningSessions?: Array<{ id: string; cwd: string }> };
      setAllSessions(data.sessions);
      if (data.runningSessions) {
        for (const rs of data.runningSessions) {
          if (rs.id && rs.cwd) knownRunningCwdsRef.current.set(rs.id, rs.cwd);
        }
      }
      // Treat the fetched running set as an initial fallback only. Once SSE is
      // live it owns this state, so a slow fetch can't revive a stale snapshot.
      if (!sseAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        if (data.runningSessions) {
          const nextCwds: Record<string, string> = {};
          for (const rs of data.runningSessions) {
            if (rs.id && rs.cwd) nextCwds[rs.id] = rs.cwd;
          }
          setRunningSessionCwds(nextCwds);
        }
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(t("sessionSidebar.loadFailed", { detail: e instanceof Error ? e.message : String(e) }));
    } finally {
      clearTimeout(timeout);
      initialLoadedRef.current = true;
      if (showLoading) setLoading(false);
    }
  }, [t]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  const projectsLoadSeqRef = useRef(0);
  const loadProjects = useCallback(async () => {
    const seq = ++projectsLoadSeqRef.current;
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { projects?: ManagedProject[] };
      // A newer request superseded this one — drop the stale response.
      if (seq !== projectsLoadSeqRef.current) return;
      setProjects(data.projects ?? []);
      setProjectsError(null);
    } catch (e) {
      if (seq !== projectsLoadSeqRef.current) return;
      setProjectsError(t("projects.loadFailed", { detail: e instanceof Error ? e.message : String(e) }));
    }
  }, [t]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshKey]);

  const [registry, setRegistry] = useState<WorkspacesRegistry>({ version: 1, workspaces: [], assignments: {} });
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);
  const workspacesLoadSeqRef = useRef(0);
  const loadWorkspaces = useCallback(async () => {
    const seq = ++workspacesLoadSeqRef.current;
    try {
      const response = await fetch("/api/workspaces", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as WorkspacesRegistry;
      if (seq !== workspacesLoadSeqRef.current) return;
      setRegistry(data);
      setWorkspacesError(null);
    } catch (cause) {
      if (seq !== workspacesLoadSeqRef.current) return;
      setWorkspacesError(t("workspaces.loadFailed", { detail: cause instanceof Error ? cause.message : String(cause) }));
    }
  }, [t]);
  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces, refreshKey, allSessions]);
  useEffect(() => { if (selectedWorkspaceIdProp) setSelectedWorkspaceId(selectedWorkspaceIdProp); }, [selectedWorkspaceIdProp]);
  const updateWorkspace = useCallback(async (body: object) => {
    ++workspacesLoadSeqRef.current;
    const next = await requestWorkspace("PATCH", body);
    setRegistry(next);
    setWorkspacesError(null);
  }, []);
  const handleRenameWorkspace = useCallback((workspaceId: string, name: string) => updateWorkspace({ action: "rename", workspaceId, name }), [updateWorkspace]);
  const handleRemoveWorkspace = useCallback((workspaceId: string) => updateWorkspace({ action: "delete", workspaceId }), [updateWorkspace]);
  const handleAssignWorkspace = useCallback((sessionId: string, workspaceId: string | null) => updateWorkspace({ action: "assign", sessionId, workspaceId }), [updateWorkspace]);


  useEffect(() => {
    const interval = setInterval(() => setRelativeTimeNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Persist expansion state; null means nothing was stored yet.
  useEffect(() => {
    if (expandedProjects === null) return;
    saveExpandedProjects(expandedProjects);
  }, [expandedProjects]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  // Debounce refresh bursts (agent_start + session_info_update + file-appear signal can fire within 250ms)
  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (pendingRefreshRef.current) return;
    pendingRefreshRef.current = setTimeout(() => {
      pendingRefreshRef.current = null;
      void loadSessions(false);
    }, 300);
  }, [loadSessions]);
  useEffect(() => () => {
    if (sessionRefreshTimerRef.current) {
      clearTimeout(sessionRefreshTimerRef.current);
      sessionRefreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Live running status and session-list invalidations arrive on the shared
    // event stream; the sidebar never has to poll while an agent is working.
    const source = openEventStream({ kind: "running" });

    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as {
          type?: string;
          runningSessionIds?: string[];
          runningSessions?: Array<{ id: string; cwd: string }>;
          exitedSessions?: ExitedRpcSession[];
          refreshSessionList?: boolean;
          sessionIds?: string[];
        };
        if (data.type === "running") {
          sseAuthoritativeRef.current = true;
          setRunningSessionIds(new Set(data.runningSessionIds ?? []));
          setExitedSessions(new Map((data.exitedSessions ?? []).map((session) => [session.id, session])));
          if (data.runningSessions) {
            const nextCwds: Record<string, string> = {};
            for (const rs of data.runningSessions) {
              if (rs.id && rs.cwd) {
                knownRunningCwdsRef.current.set(rs.id, rs.cwd);
                nextCwds[rs.id] = rs.cwd;
              }
            }
            setRunningSessionCwds(nextCwds);
          }
          if (data.refreshSessionList) scheduleRefresh();
        } else if (data.type === "sessions-changed") {
          if (data.refreshSessionList) scheduleRefresh();
          publishSessionsChanged(data.sessionIds ?? []);
        }
      } catch {
        // ignore malformed frames
      }
    };

    source.onerror = () => {
      // The stream reconnects on its own; until a fresh frame arrives, let the
      // polled /api/sessions fallback own running state again.
      sseAuthoritativeRef.current = false;
    };
    return () => {
      if (pendingRefreshRef.current) clearTimeout(pendingRefreshRef.current);
      source.close();
    };
  }, [loadSessions, scheduleRefresh]);
  // Long-idle recovery: while the tab is hidden the SSE connection can die
  // (laptop sleep, network change, tab freeze) and its EventSource reconnect
  // carries no list invalidation. Refresh whenever the user actually comes
  // back or the network returns, so the list is never left stale/empty.
  useEffect(() => {
    const refresh = () => {
      void loadSessions(false);
      void loadWorkspaces();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onOnline = refresh;
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [loadSessions, loadWorkspaces]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    // A brand-new session's JSONL does not exist until the first assistant
    // turn makes progress — but its running badge must show immediately
    // via the optimistic row. Once any session completes (or a new session
    // appears on disk), reload so it replaces the optimistic placeholder
    // without waiting for another refresh trigger.
    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      loadSessions(false);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);


  const restoredRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available.
   *  The worktree/branch cache is keyed per repository, so this lookup is
   *  scoped: a worktree belongs to the repository whose cached GitState lists
   *  it — never to a different repository's state. */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    for (const state of Object.values(worktreeStateByProject)) {
      if (state.worktrees.some((w) => normalizeProjectKey(w.path) === normalizeProjectKey(cwd))) {
        return state.projectRoot;
      }
    }
    // Fall back to the project registry, then to session cwd→root matches, so
    // a session whose projectKey was normalized server-side still resolves to
    // the registry's case-preserved path — the caller gets a canonical value.
    const registered = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cwd));
    if (registered) return registered.path;
    const foldedCwd = comparableProjectPath(cwd);
    const match = allSessions.find((s) => comparableProjectPath(s.cwd) === foldedCwd);
    return match?.projectRoot ?? cwd;
  }, [worktreeStateByProject, allSessions, projects]);

  // ---- Expansion (used by the sync/notify effects below, so declared first) --
  // Keys are stored in comparableProjectPath form so case-variant spellings of
  // the same Windows path map to one entry (the server lowercases projectKey
  // on win32, while project.path preserves registry casing).
  const expandProject = useCallback((path: string) => {
    const key = comparableProjectPath(path);
    setExpandedProjects((prev) => {
      if (prev?.has(key)) return prev;
      const next = new Set(prev ?? []);
      next.add(key);
      return next;
    });
  }, []);


  const toggleWorkspaceExpanded = useCallback((id: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);


  const activateWorkspace = useCallback((workspace: Workspace) => {
    provisionalSelectionRef.current = false;
    setSelectedWorkspaceId(workspace.id);
    setSelectedCwd(workspace.cwd);
    expandProject(workspace.id);
    onNewSession?.("workspace", workspace.cwd, workspace.id);
  }, [expandProject, onNewSession]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back. Sessions
  // picked outside the sidebar (URL restore, command palette) also expand
  // their containing project.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    // A withdrawn command must not swallow the next one: without this reset,
    // re-commanding a cwd the sidebar already synced (A -> sidebar B -> A)
    // stays stuck on B.
    if (!selectedCwdProp) {
      lastSyncedCwdPropRef.current = null;
      return;
    }
    if (selectedCwdProp !== lastSyncedCwdPropRef.current) {
      provisionalSelectionRef.current = false;
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
      const project = projectRootFor(selectedCwdProp);
      if (project) expandProject(project);
    }
  }, [selectedCwdProp, projectRootFor, expandProject]);

  // Load worktrees/branch data for the repository containing the current
  // effective cwd. Results are cached in worktreeStateByProject keyed by the
  // normalized repository root, so each workspace keeps its own Git context:
  //  • switching to another repo leaves this repo's cached state intact, and
  //  • a late response for the previously-selected repo writes only that
  //    repo's entry (never the active repo's, so it can't overwrite the UI).
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  const storeWorktreeState = useCallback((requestedCwd: string, d: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[]; error?: string }) => {
    if (d.error || !d.projectRoot) {
      // This cwd is not a Git repo (or the lookup failed) — the workspace
      // should show no branch/worktrees. Other repos' cached state is left
      // intact: a non-Git workspace never inherits another repo's branch, and
      // we never discard previously-visited repos' Git state.
      return;
    }
    const projectRoot = d.projectRoot;
    const entry: WorktreeState = {
      forCwd: requestedCwd,
      projectRoot,
      isGit: d.isGit ?? false,
      isTopLevel: d.isTopLevel ?? false,
      worktrees: d.worktrees ?? [],
    };
    setWorktreeStateByProject((prev) => {
      const key = normalizeProjectKey(projectRoot);
      const existing = prev[key];
      if (existing && normalizeProjectKey(existing.projectRoot) !== key) {
        const next = { ...prev };
        delete next[normalizeProjectKey(existing.projectRoot)];
        next[key] = entry;
        return next;
      }
      return { ...prev, [key]: entry };
    });
  }, []);
  useLayoutEffect(() => {
    if (!selectedCwd) return;
    let cancelled = false;
    const requestedCwd = selectedCwd;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(requestedCwd)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) storeWorktreeState(requestedCwd, d); })
      .catch(() => { /* leave any cached state; refetch on demand */ });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey, storeWorktreeState]);

  // Keep a just-created session and its project visible while omp is still
  // flushing the JSONL file. The server list remains authoritative once it
  // contains the same id.
  // IMPORTANT: derive synchronously — the previous projectRootFor(cwd) needs
  // the async /api/worktrees git lookup, so the optimistic row would park in
  // cwd-bucket then jump to repo bucket. Use registered-project match first.
  const optimisticProjectRoot = (() => {
    if (!optimisticSession) return null;
    if (optimisticSession.projectRoot) return optimisticSession.projectRoot;
    if (optimisticSession.projectKey) return optimisticSession.projectKey;
    const cw = optimisticSession.cwd ?? "";
    if (!cw) return null;
    const reg = projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(cw));
    if (reg) return reg.path;
    return cw;
  })();
  // Stable placeholder timestamps: Date.now() inside the memo would churn every refresh and bust downstream memos.
  const placeholderTsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (optimisticSession?.id && optimisticSession.cwd) {
      knownRunningCwdsRef.current.set(optimisticSession.id, optimisticSession.cwd);
      setRunningSessionCwds((prev) => (prev[optimisticSession.id] === optimisticSession.cwd ? prev : { ...prev, [optimisticSession.id]: optimisticSession.cwd }));
    }
  }, [optimisticSession]);
  const visibleSessions = useMemo(() => {
    let base = allSessions;
    if (optimisticSession && !base.some((session) => session.id === optimisticSession.id)) {
      const stableRoot = optimisticProjectRoot ?? optimisticSession.cwd;
      const stableKey = stableRoot ? comparableProjectPath(stableRoot) : undefined;
      base = [...base, { ...optimisticSession, projectRoot: stableRoot ?? optimisticSession.cwd, ...(stableKey ? { projectKey: stableKey } : {}) }];
    }
    // A running session's JSONL may not exist yet (first turn still
    // streaming). Keep it in the list so navigating away never hides it
    // until the file lands and the next refresh replaces the placeholder.
    const known = new Set(base.map((s) => s.id));
    const placeholders: SessionInfo[] = [];
    const visibleLiveIds = new Set(runningSessionIds);
    for (const id of exitedSessions.keys()) visibleLiveIds.add(id);
    for (const id of visibleLiveIds) {
      if (known.has(id)) continue;
      let ts = placeholderTsRef.current.get(id);
      if (!ts) {
        ts = new Date().toISOString();
        placeholderTsRef.current.set(id, ts);
      }
      const isOptimistic = optimisticSession?.id === id;
      const sessionCwd = (isOptimistic ? optimisticSession.cwd : null)
        ?? runningSessionCwds[id]
        ?? exitedSessions.get(id)?.cwd
        ?? knownRunningCwdsRef.current.get(id)
        ?? selectedCwd
        ?? "";
      const resolvedRoot = isOptimistic
        ? (optimisticProjectRoot ?? optimisticSession.projectRoot ?? optimisticSession.cwd)
        : (projectRootFor(sessionCwd) ?? sessionCwd);
      const phRoot = resolvedRoot ?? "";
      const phKey = phRoot ? comparableProjectPath(phRoot) : undefined;
      placeholders.push({
        id,
        path: "",
        cwd: sessionCwd,
        name: undefined,
        created: ts,
        modified: ts,
        messageCount: 1,
        firstMessage: "",
        projectRoot: phRoot,
        ...(phKey ? { projectKey: phKey } : {}),
      });
    }
    // Prune timestamps and known cwds for ids that are now materialized or no longer live.
    if (placeholderTsRef.current.size > placeholders.length) {
      for (const key of [...placeholderTsRef.current.keys()]) {
        if (!visibleLiveIds.has(key) || known.has(key)) placeholderTsRef.current.delete(key);
      }
    }
    if (knownRunningCwdsRef.current.size > visibleLiveIds.size + (optimisticSession ? 1 : 0)) {
      if (optimisticSession) visibleLiveIds.add(optimisticSession.id);
      for (const key of [...knownRunningCwdsRef.current.keys()]) {
        if (!visibleLiveIds.has(key) && known.has(key)) knownRunningCwdsRef.current.delete(key);
      }
    }
    return placeholders.length ? [...base, ...placeholders] : base;
  }, [allSessions, optimisticSession, optimisticProjectRoot, runningSessionIds, runningSessionCwds, exitedSessions, projectRootFor, selectedCwd]);
  const selectedProject = useMemo(() => projectRootFor(selectedCwd), [projectRootFor, selectedCwd]);
  const workspaces = useMemo(() => [...registry.workspaces].sort((a, b) => a.order - b.order), [registry.workspaces]);
  const assignments = useMemo(() => optimisticSession && optimisticWorkspaceId && !registry.assignments[optimisticSession.id]
    ? { ...registry.assignments, [optimisticSession.id]: optimisticWorkspaceId }
    : registry.assignments, [registry.assignments, optimisticSession, optimisticWorkspaceId]);
  const workspaceEntries = useMemo(() => groupWorkspaceSessions(workspaces, visibleSessions, assignments), [workspaces, visibleSessions, assignments]);
  const activeWorkspaceId = (selectedSessionId ? assignments[selectedSessionId] : null)
    ?? (workspaces.some(workspace => workspace.id === selectedWorkspaceId) ? selectedWorkspaceId : null)
    ?? workspaces.find(workspace => comparableProjectPath(workspace.cwd) === comparableProjectPath(selectedCwd ?? ""))?.id
    ?? workspaces[0]?.id ?? null;
  useEffect(() => {
    onWorkspaceOptionsChange?.(workspaces, activeWorkspaceId);
  }, [onWorkspaceOptionsChange, workspaces, activeWorkspaceId]);
  useEffect(() => {
    if (selectedSessionId && activeWorkspaceId) expandProject(activeWorkspaceId);
  }, [selectedSessionId, activeWorkspaceId, expandProject]);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const visibleWorkspaceEntries = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase();
    return workspaceEntries.map(entry => {
      const nameMatches = entry.workspace.name.toLowerCase().includes(query);
      return { ...entry, sessions: entry.sessions.filter(session => (!runningOnly || runningSessionIds.has(session.id))
        && (!query || nameMatches || `${session.name ?? ""} ${session.firstMessage} ${session.id}`.toLowerCase().includes(query))) };
    }).filter(entry => (!query && !runningOnly) || entry.sessions.length > 0 || (!runningOnly && entry.workspace.name.toLowerCase().includes(query)));
  }, [workspaceEntries, deferredSearchQuery, runningOnly, runningSessionIds]);
  const treesByWorkspace = useMemo(() => new Map(visibleWorkspaceEntries.map(({ workspace, sessions }) => [workspace.id, buildSessionTree(sessions)])), [visibleWorkspaceEntries]);
  const nativeParentIds = useMemo(() => new Set(visibleSessions.flatMap(session => session.parentSessionId ? [session.parentSessionId] : [])), [visibleSessions]);

  // True while the auto-selected project was chosen before projects loaded
  // (ordering incomplete); cleared by any manual activation.
  const provisionalSelectionRef = useRef(false);

  // A just-started session's JSONL is not flushed until its first turn makes
  // progress, so a URL reopened in that window has no list entry yet. Retry
  // the list a few times before declaring the restore failed.
  const restoreRetryRef = useRef(0);
  const restoreRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (restoreRetryTimerRef.current) {
      clearTimeout(restoreRetryTimerRef.current);
      restoreRetryTimerRef.current = null;
    }
  }, []);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (skipInitialProjectSelection) return;

    // If restoring a session, set cwd to match that session
    if (initialSessionId && !restoredRef.current) {
      // An empty list only blocks while the first load is still in flight —
      // a settled-but-empty or failed load means the target will never appear
      // (shared ?session= link, deleted session), so fall through to the
      // retry/exhaustion path below instead of returning forever.
      if (allSessions.length === 0 && !initialLoadedRef.current) return; // wait for sessions to load
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        restoreRetryRef.current = 0;
        restoredRef.current = true;
        setSelectedCwd(target.cwd);
        expandProject(comparableProjectPath(workspaceKeyOf(target)));
        onSelectSession(target, true);
        return;
      }
      if (restoreRetryRef.current < INITIAL_RESTORE_MAX_ATTEMPTS) {
        restoreRetryRef.current += 1;
        if (restoreRetryTimerRef.current) {
          clearTimeout(restoreRetryTimerRef.current);
          restoreRetryTimerRef.current = null;
        }
        restoreRetryTimerRef.current = setTimeout(() => {
          restoreRetryTimerRef.current = null;
          void loadSessions(false);
        }, INITIAL_RESTORE_RETRY_MS);
        return;
      }
      restoreRetryRef.current = 0;
      restoredRef.current = true;
      // Session not found — notify parent so it can show the placeholder
      onInitialRestoreDone?.();
    }
    // No restore target: activate the top project (most recently added) so New
    // Session and Explorer have a context. When projects have not loaded yet
    // the ordering is provisional — re-pick once they arrive, unless the user
    // already activated a project by hand.
    if (selectedCwd !== null && !provisionalSelectionRef.current) return;
    const top = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? workspaces[0];
    if (!top) return;
    setSelectedWorkspaceId(top.id);
    setSelectedCwd(top.cwd);
    expandProject(top.id);
    provisionalSelectionRef.current = false;
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, workspaces, activeWorkspaceId, expandProject, loadSessions]);

  // Default expansion: when the user has never stored an expansion choice,
  // expand only the active project.
  const defaultExpandedRef = useRef(false);
  useEffect(() => {
    if (defaultExpandedRef.current) return;
    if (!activeWorkspaceId) return;
    defaultExpandedRef.current = true;
    if (expandedProjects === null) expandProject(activeWorkspaceId);
  }, [activeWorkspaceId, expandedProjects, expandProject]);

  const commitAddWorkspace = useCallback(async (name: string) => {
    if (!pendingWorkspace || addProjectBusy) return;
    setAddProjectBusy(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: pendingWorkspace.cwd, launchConfig: pendingWorkspace.launchConfig }),
      });
      const data = await response.json() as { project?: ManagedProject; error?: string; code?: string };
      if (!response.ok || !data.project) throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${response.status}` }));
      ++workspacesLoadSeqRef.current;
      const next = await requestWorkspace("POST", { name, cwd: data.project.path });
      setRegistry(next);
      await loadProjects();
      const created = next.workspaces.filter(workspace => !workspaces.some(existing => existing.id === workspace.id)).sort((a, b) => b.order - a.order)[0];
      if (created) activateWorkspace(created);
      setPendingWorkspace(null);
    } finally { setAddProjectBusy(false); }
  }, [pendingWorkspace, addProjectBusy, workspaces, loadProjects, activateWorkspace]);

  const handleUpdateProjectPresentation = useCallback(async (projectPath: string, updates: { alias?: string | null; sortOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }) => {
    try {
      const response = await fetch("/api/projects", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectPath, ...updates }) });
      if (!response.ok) throw new Error(t("projects.updateFailed"));
      await loadProjects();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [loadProjects, t]);


  // Create/remove operate against the active repo's own cached Git state —
  // never a globally stored path, so the branch lands in the correct repo.
  // Failures reject with a user-facing message for the Worktrees tab to show.
  const handleCreateWorktree = useCallback(async (branch: string) => {
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!activeState) return;
    const root = activeState.projectRoot;
    const res = await fetch("/api/worktrees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: root, branch }),
    });
    const data = await res.json().catch(() => ({})) as { path?: string; error?: string; code?: string };
    if (!res.ok || data.error || !data.path) {
      throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
    }
    const newWorktreePath: string = data.path;
    // Optimistically register the new worktree against THIS repo's cached
    // entry so projectRootFor() resolves it to the main repo before the
    // refetch lands (keeps AppShell from treating the new cwd as a different
    // project). Other repos' cached state is untouched.
    setWorktreeStateByProject((prev) => {
      const key = normalizeProjectKey(root);
      const existing = prev[key];
      if (!existing) return prev;
      const newWt: WorktreeEntry = { path: newWorktreePath, branch, isMain: false };
      return { ...prev, [key]: { ...existing, forCwd: newWorktreePath, worktrees: [...existing.worktrees, newWt] } };
    });
    setSelectedCwd(newWorktreePath);
    setWtRefreshKey((k) => k + 1);
    loadSessions(false);
    void loadProjects();
  }, [selectedProject, worktreeStateByProject, loadProjects, loadSessions]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean): Promise<"removed" | "dirty"> => {
    const activeState = selectedProject ? worktreeStateByProject[normalizeProjectKey(selectedProject)] : undefined;
    if (!activeState) return "removed";
    const root = activeState.projectRoot;
    const res = await fetch("/api/worktrees", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: root, path, force }),
    });
    const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean; code?: string };
    if (!res.ok) {
      // Dirty worktree — the caller asks the user to confirm a force removal.
      if (data.dirty && !force) return "dirty";
      throw new Error(formatApiError({ ...data, error: data.error ?? `HTTP ${res.status}` }));
    }
    // Optimistically remove the deleted worktree from the active project's state
    setWorktreeStateByProject((prev) => {
      const key = normalizeProjectKey(root);
      const existing = prev[key];
      if (!existing) return prev;
      const nextWorktrees = existing.worktrees.filter((w) => comparableProjectPath(w.path) !== comparableProjectPath(path));
      return {
        ...prev,
        [key]: {
          ...existing,
          forCwd: selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path) ? root : existing.forCwd,
          worktrees: nextWorktrees,
        },
      };
    });
    if (selectedCwd !== null && comparableProjectPath(selectedCwd) === comparableProjectPath(path)) {
      setSelectedCwd(root);
    }
    setWtRefreshKey((k) => k + 1);
    loadSessions(false);
    void loadProjects();
    return "removed";
  }, [selectedProject, worktreeStateByProject, selectedCwd, loadProjects, loadSessions]);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees. Selecting a session also
  // activates and expands its containing project.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    provisionalSelectionRef.current = false;
    if (s.cwd) setSelectedCwd(s.cwd);
    const workspaceId = assignments[s.id];
    if (workspaceId) { setSelectedWorkspaceId(workspaceId); expandProject(workspaceId); }
    onSelectSession(s);
  }, [onSelectSession, expandProject, assignments]);

  const handleNewSession = useCallback(() => {
    const workspace = workspaces.find(workspace => workspace.id === activeWorkspaceId);
    if (workspace) activateWorkspace(workspace);
  }, [workspaces, activeWorkspaceId, activateWorkspace]);

  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImportSession = useCallback(async (file: File | null) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      const content = await file.text();
      const res = await fetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
      if (!res.ok || !data.success) {
        toast.error(data.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(t("sessionSidebar.imported"));
      loadSessions(false);
      void loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [importing, loadSessions, loadProjects, t]);

  // Sessions of every worktree in the selected project are shown together.
  // Keys are comparableProjectPath forms (see expandProject) — comparable to
  // the folded registry paths rows are checked against.
  const expandedProjectKeys = expandedProjects ?? EMPTY_PROJECT_SET;

  // The active repo's own cached Git state, selected by repository root — never
  // a single sidebar-wide variable, so it is always the state belonging to the
  // repo the user currently has active.
  const activeGitState = selectedProject
    ? worktreeStateByProject[normalizeProjectKey(selectedProject)]
    : undefined;

  const showWorktreeSwitcher = Boolean(
    activeGitState?.isGit
    && activeGitState.isTopLevel
    && selectedCwd
    && selectedProject !== null
    // Case-folded: the active project may be spelled differently than the
    // server-resolved git root (Windows/NTFS), yet still be the same repo.
    && comparableProjectPath(selectedProject) === comparableProjectPath(activeGitState.projectRoot),
  );
  // The file panel's Worktrees tab renders the ACTIVE repo's own worktrees
  // only; non-Git / subdirectory workspaces get null (no Git affordance).
  const worktreeContext = useMemo<WorktreeContext | null>(() => {
    if (!showWorktreeSwitcher || !activeGitState) return null;
    const foldedCwd = comparableProjectPath(selectedCwd ?? "");
    const current = activeGitState.worktrees.find((w) => comparableProjectPath(w.path) === foldedCwd)
      ?? activeGitState.worktrees.find((w) => w.isMain);
    return {
      projectRoot: activeGitState.projectRoot,
      worktrees: activeGitState.worktrees,
      currentPath: current?.path ?? activeGitState.projectRoot,
      select: setSelectedCwd,
      create: handleCreateWorktree,
      remove: handleRemoveWorktree,
    };
  }, [showWorktreeSwitcher, activeGitState, selectedCwd, handleCreateWorktree, handleRemoveWorktree]);
  useEffect(() => {
    onWorktreeContextChange?.(worktreeContext);
  }, [onWorktreeContextChange, worktreeContext]);

  // Stable callbacks for the session list so memoized children don't re-render
  // on every parent state change.
  const handleSessionDeleted = useCallback((id: string) => {
    const deleted = allSessions.find((session) => session.id === id);
    if (deleted) clearLastOpenSession(workspaceKeyOf(deleted));
    onSessionDeleted?.(id);
    loadSessions();
  }, [allSessions, onSessionDeleted, loadSessions]);

  useEffect(() => {
    const selected = allSessions.find((session) => session.id === selectedSessionId);
    if (selected) setLastOpenSession(workspaceKeyOf(selected), selected.id);
  }, [allSessions, selectedSessionId]);

  return (
    <div className="sidebar-shell" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {addProjectOpen && (
        <DirectoryPicker
          busy={addProjectBusy}
          error={addProjectError}
          onCancel={() => {
            setAddProjectOpen(false);
            setAddProjectError(null);
          }}
          onSelect={(cwd, launchConfig) => { setAddProjectOpen(false); setPendingWorkspace({ cwd, launchConfig }); }}
        />
      )}
      {pendingWorkspace && <WorkspaceNameDialog title={t("workspaces.create")} onClose={() => setPendingWorkspace(null)} onSave={commitAddWorkspace} />}
      {launchConfigProject && (
        <ProjectLaunchConfigDialog
          projectPath={launchConfigProject.path}
          initialConfig={launchConfigProject.launchConfig}
          onClose={() => setLaunchConfigProject(null)}
          onSave={async (launchConfig) => {
            await handleUpdateProjectPresentation(launchConfigProject.path, { launchConfig });
            toast.info(t("sessionSidebar.launchConfigSaved"));
          }}
        />
      )}
      {/* Header: branding + quiet utilities + New Session */}
      <div
        style={{
          padding: "10px 10px 8px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title={t("appShell.hideSidebar")}
                aria-label={t("appShell.hideSidebar")}
                className="shell-toolbar-btn ui-focus-ring"
              >
                <X size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <OmpWebTitle />
          </div>
          <div style={{ display: "flex", gap: 2 }}>
            {navigation && (
              <span className="sidebar-nav-buttons">
                <Tooltip content={`${t("sessionSidebar.navigateBack")} (${navigation.backShortcut})`} side="bottom">
                  <SidebarIconButton
                    label={t("sessionSidebar.navigateBack")}
                    onClick={navigation.onBack}
                    disabled={!navigation.canBack}
                  >
                    <ArrowLeft size={15} strokeWidth={1.9} aria-hidden="true" />
                  </SidebarIconButton>
                </Tooltip>
                <Tooltip content={`${t("sessionSidebar.navigateForward")} (${navigation.forwardShortcut})`} side="bottom">
                  <SidebarIconButton
                    label={t("sessionSidebar.navigateForward")}
                    onClick={navigation.onForward}
                    disabled={!navigation.canForward}
                  >
                    <ArrowRight size={15} strokeWidth={1.9} aria-hidden="true" />
                  </SidebarIconButton>
                </Tooltip>
              </span>
            )}
            {onOpenArchive && (
              <Tooltip content={t("sessionSidebar.archiveBrowserTitle")} side="bottom">
                <SidebarIconButton
                  label={t("sessionSidebar.archiveBrowser")}
                  onClick={onOpenArchive}
                >
                  <Archive size={14} strokeWidth={1.9} aria-hidden="true" />
                </SidebarIconButton>
              </Tooltip>
            )}
            <Tooltip content={t("sessionSidebar.importTitle")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.import")}
                onClick={() => importInputRef.current?.click()}
                disabled={importing}
              >
                <FileUp size={14} strokeWidth={1.9} aria-hidden="true" />
              </SidebarIconButton>
            </Tooltip>
            <Tooltip content={t("sessionSidebar.refresh")} side="bottom">
              <SidebarIconButton
                label={t("sessionSidebar.refresh")}
                active={sessionRefreshDone}
                onClick={() => {
                  loadSessions(false);
                  void loadProjects();
                  void loadWorkspaces();
                }}
              >
                {sessionRefreshDone ? (
                  <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />
                )}
              </SidebarIconButton>
            </Tooltip>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept=".jsonl,.json,application/json,application/jsonl"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = "";
            void handleImportSession(file);
          }}
        />
        <button
          onClick={handleNewSession}
          disabled={!selectedCwd}
          className="sidebar-new-session"
          title={selectedCwd ? t("sessionSidebar.newSessionIn", { cwd: selectedCwd }) : t("sessionSidebar.selectProjectFirst")}
          style={{
            width: "100%",
            height: 38,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            color: selectedCwd ? "var(--text)" : "var(--text-dim)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            opacity: selectedCwd ? 1 : 0.65,
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => {
            if (!selectedCwd) return;
            e.currentTarget.style.background = "var(--bg-selected)";
            e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 30%, transparent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          <Plus size={15} strokeWidth={2.2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />
          <span>{t("sessionSidebar.new")}</span>
        </button>
      </div>

      {/* Workspaces section header: label + search / filter / add */}
      <div style={{ flexShrink: 0, padding: "4px 10px 2px", display: "flex", alignItems: "center", gap: 2 }}>
        <span
          style={{
            flex: 1,
            color: "var(--text-muted)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {t("projects.heading")}
        </span>
        <SidebarIconButton
          label={t("sessionSidebar.search")}
          title={t("sessionSidebar.searchTitle")}
          active={searchOpen}
          onClick={() => {
            const nextOpen = !searchOpen;
            setSearchOpen(nextOpen);
            if (nextOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
            else setSearchQuery("");
          }}
        >
          <Search size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("sessionSidebar.filterRunning")}
          title={t("sessionSidebar.filterRunningTitle")}
          active={runningOnly}
          onClick={() => setRunningOnly((v) => !v)}
        >
          <SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
        <SidebarIconButton
          label={t("workspaces.create")}
          title={t("workspaces.create")}
          onClick={() => {
            setAddProjectOpen(true);
            setAddProjectError(null);
          }}
        >
          <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
        </SidebarIconButton>
      </div>
      {searchOpen && (
        <div style={{ padding: "0 10px 6px", flexShrink: 0 }}>
          <input
            className="sidebar-session-search"
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
              }
            }}
            placeholder={t("sessionSidebar.searchPlaceholder")}
            aria-label={t("sessionSidebar.search")}
            style={{
              width: "100%",
              height: 27,
              boxSizing: "border-box",
              padding: "0 9px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              outline: "none",
              color: "var(--text)",
              fontSize: 12,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
        </div>
      )}

      {/* Workspaces */}
        <div
          style={{
            flex: "1 1 auto",
            overflowY: "auto",
            padding: "2px 10px 10px",
            minHeight: 80,
          }}
        >
          {loading && (
            <div role="status" aria-live="polite" aria-label={t("sessionSidebar.loading")} style={{ display: "grid", gap: 10, padding: "10px 4px" }}>
              <div aria-hidden="true" className="skeleton" style={{ width: "78%", height: 18 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "92%", height: 30 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "86%", height: 30 }} />
              <div aria-hidden="true" className="skeleton" style={{ width: "68%", height: 30 }} />
            </div>
          )}
          {workspacesError && (
            <div role="alert" style={{ padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>
              {workspacesError}
              <button className="load-retry-button" type="button" onClick={() => void loadWorkspaces()}>{t("sessionSidebar.refresh")}</button>
            </div>
          )}
          {projectsError && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>
              <span>{projectsError}</span>
              <button className="load-retry-button" type="button" onClick={() => { loadSessions(false); void loadProjects(); }} style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("sessionSidebar.refresh")}</button>
            </div>
          )}
          {error && (
            <div role="alert" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>
              <span>{error}</span>
              <button className="load-retry-button" type="button" onClick={() => { loadSessions(false); void loadProjects(); }} style={{ minHeight: 32, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("sessionSidebar.refresh")}</button>
            </div>
          )}
          {!loading && !workspacesError && !error && workspaces.length === 0 && (
            <div style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
              {t("projects.noProjects")}
            </div>
          )}
          {!loading && !workspacesError && !error && workspaces.length > 0 && visibleWorkspaceEntries.length === 0 && (
            <div style={{ padding: "14px 4px", color: "var(--text-dim)", fontSize: 11.5, lineHeight: 1.5 }}>
              {t("sessionSidebar.noMatches")}
            </div>
          )}

          {visibleWorkspaceEntries.map(({ workspace, sessions }) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              project={projects.find(project => comparableProjectPath(project.path) === comparableProjectPath(workspace.cwd)) ?? { path: workspace.cwd }}
              workspaces={workspaces}
              assignments={assignments}
              isActive={activeWorkspaceId === workspace.id}
              isExpanded={expandedProjectKeys.has(workspace.id)}
              tree={treesByWorkspace.get(workspace.id) ?? buildSessionTree(sessions)}
              nativeParentIds={nativeParentIds}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              exitedSessions={exitedSessions}
              relativeTimeNow={relativeTimeNow}
              onActivate={activateWorkspace}
              onNewSession={activateWorkspace}
              onToggleExpand={toggleWorkspaceExpanded}
              onRemoveWorkspace={handleRemoveWorkspace}
              onRenameWorkspace={handleRenameWorkspace}
              onAssignWorkspace={handleAssignWorkspace}
              onEditLaunchConfig={setLaunchConfigProject}
              onSelectSession={handleSelectSessionFromList}
              onRenamed={loadSessions}
              onSessionDeleted={handleSessionDeleted}
            />
          ))}
        </div>

      {/* Provider usage bar — pinned above Settings */}
      {usageVisible && <ProviderUsageBar />}
      {/* Pinned footer: Settings */}
      <div style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        <button
          className="sidebar-settings-row"
          data-active={settingsOpen}
          onClick={onOpenSettings}
          title={t("chatInput.settings")}
          aria-label={t("chatInput.settings")}
          style={{
            width: "100%",
            height: 36,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 12px",
            background: settingsOpen ? "var(--bg-selected)" : "none",
            border: "none",
            color: settingsOpen ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
            transition: SIDEBAR_BUTTON_TRANSITION,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = settingsOpen ? "var(--bg-selected)" : "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = settingsOpen ? "var(--bg-selected)" : "none"; e.currentTarget.style.color = settingsOpen ? "var(--text)" : "var(--text-muted)"; }}
        >
          <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
            <Settings2 size={14} strokeWidth={2} aria-hidden="true" />
            {updateAvailable && (
              <span
                aria-label={t("skillsConfig.updateAvailable")}
                role="status"
                style={{ position: "absolute", top: -3, right: -4, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", border: "1px solid var(--bg-panel)" }}
              />
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 500 }}>
            {t("chatInput.settings")}
          </span>
          <ChevronRight size={13} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
});







