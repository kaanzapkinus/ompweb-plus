"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import type { ExitedRpcSession, SessionInfo, Workspace } from "@/lib/types";
import type { ChatSearchResult, RecentChatsResponse, SessionSearchResponse } from "@/lib/session-discovery-types";
import { formatExitedSessionNotice, useI18n } from "@/lib/i18n";
import { groupWorkspaceSessions } from "@/lib/workspace-view";
import { ExitedSessionIndicator, RunningSessionIndicator, SidebarIconButton, UnreadSessionIndicator } from "./SessionSidebar-chrome";

interface Props {
  workspaces: Workspace[];
  assignments: Record<string, string>;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  exitedSessions: Map<string, ExitedRpcSession>;
  runningOnly: boolean;
  onRunningOnlyChange: () => void;
  onSelectSession: (session: SessionInfo) => void;
  /** Incremented only by the existing session-list refresh lifecycle. */
  refreshKey: number;
  children: ReactNode;
}

interface DiscoveryState {
  query: string;
  refreshKey: number;
  results: ChatSearchResult[];
  recents: RecentChatsResponse["sessions"];
  total: number;
  nextOffset: number;
  hasMore: boolean;
  unavailable: number;
  loading: boolean;
  error: boolean;
  failedOffset: number;
}

function pendingState(query: string, refreshKey: number): DiscoveryState {
  return { query, refreshKey, results: [], recents: [], total: 0, nextOffset: 0, hasMore: false, unavailable: 0, loading: true, error: false, failedOffset: 0 };
}

export function SessionDiscovery({ workspaces, assignments, selectedSessionId, runningSessionIds, unreadSessionIds, exitedSessions, runningOnly, onRunningOnlyChange, onSelectSession, refreshKey, children }: Props) {
  const { t, tn } = useI18n();
  const [input, setInput] = useState("");
  const query = input.trim().replace(/\s+/g, " ");
  const [recentsExpanded, setRecentsExpanded] = useState(true);
  const recentsId = useId();
  const [state, setState] = useState<DiscoveryState>(() => pendingState("", refreshKey));
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadedWindowRef = useRef({ query: "", count: 0 });
  const current = state.query !== query
    ? pendingState(query, refreshKey)
    : state.refreshKey === refreshKey ? state : { ...state, loading: true, error: false };

  const invalidate = useCallback(() => {
    ++generationRef.current;
    controllerRef.current?.abort();
  }, []);

  const requestPage = useCallback(async (offset: number, generation: number, controller: AbortController) => {
    const isCurrent = () => generation === generationRef.current && !controller.signal.aborted;
    try {
      const url = query
        ? `/api/sessions/search?${new URLSearchParams({ q: query, offset: String(offset), limit: "50" })}`
        : "/api/sessions/recent";
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (query) {
        let data = await response.json() as SessionSearchResponse;
        if (!isCurrent()) return;
        const windowSize = offset === 0 && loadedWindowRef.current.query === query ? loadedWindowRef.current.count : 0;
        const refreshed = [...data.results];
        let consumed = data.results.length;
        while (data.hasMore && data.results.length > 0 && consumed < windowSize) {
          const next = await fetch(`/api/sessions/search?${new URLSearchParams({ q: query, offset: String(consumed), limit: "50" })}`, { signal: controller.signal, cache: "no-store" });
          if (!next.ok) throw new Error(`HTTP ${next.status}`);
          data = await next.json() as SessionSearchResponse;
          if (!isCurrent()) return;
          refreshed.push(...data.results);
          consumed += data.results.length;
        }
        loadedWindowRef.current = { query, count: offset + consumed };
        setState(previous => {
          const prior = offset > 0 ? previous.results : [];
          const seen = new Set(prior.map(result => result.session.id));
          const appended = refreshed.filter(result => {
            if (seen.has(result.session.id)) return false;
            seen.add(result.session.id);
            return true;
          });
          return { ...pendingState(query, refreshKey), results: [...prior, ...appended], total: data.total, nextOffset: offset + consumed, hasMore: data.hasMore, unavailable: data.unavailable, loading: false };
        });
      } else {
        const data = await response.json() as RecentChatsResponse;
        if (!isCurrent()) return;
        // The server alone orders recents by message activity; never re-sort by
        // session.modified, selection, or workspace metadata here.
        setState({ ...pendingState(query, refreshKey), recents: data.sessions, unavailable: data.unavailable, loading: false });
      }
    } catch {
      if (!isCurrent()) return;
      setState(previous => ({ ...previous, loading: false, error: true, failedOffset: offset }));
    }
  }, [query, refreshKey]);

  useEffect(() => {
    invalidate();
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState(previous => previous.query === query
      ? { ...previous, refreshKey, loading: true, error: false }
      : pendingState(query, refreshKey));
    const timer = query ? setTimeout(() => void requestPage(0, generation, controller), 250) : undefined;
    if (!query) void requestPage(0, generation, controller);
    return () => {
      clearTimeout(timer);
      invalidate();
    };
  }, [query, refreshKey, requestPage, invalidate]);

  function changeQuery(value: string) {
    // Invalidate in the input event, not just effect cleanup: even a response
    // settling before the next effect must not commit an old query's rows.
    if (value.trim().replace(/\s+/g, " ") !== query) {
      invalidate();
      loadedWindowRef.current = { query: value.trim().replace(/\s+/g, " "), count: 0 };
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }
    setInput(value);
  }

  function loadPage(offset: number) {
    if (current.loading) return;
    invalidate();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState(previous => ({ ...previous, loading: true, error: false }));
    void requestPage(offset, generationRef.current, controller);
  }

  const sessions = useMemo(() => query ? current.results.map(result => result.session) : current.recents, [query, current.results, current.recents]);
  const workspaceNames = useMemo(() => new Map(groupWorkspaceSessions(workspaces, sessions, assignments).flatMap(group => group.sessions.map(session => [session.id, group.workspace.name] as const))), [workspaces, sessions, assignments]);
  const visibleResults = current.results.filter(result => !runningOnly || runningSessionIds.has(result.session.id));
  const visibleRecents = current.recents.filter(session => !runningOnly || runningSessionIds.has(session.id));

  function row(session: SessionInfo, match?: ChatSearchResult) {
    const exited = exitedSessions.get(session.id);
    const title = session.name || session.firstMessage || t("notifications.untitledSession");
    const workspace = workspaceNames.get(session.id) ?? session.cwd;
    return (
      <button key={session.id} type="button" className="session-item-button sidebar-discovery-row" data-session-id={session.id} data-session-path={session.path} aria-current={session.id === selectedSessionId ? "true" : undefined} onClick={() => onSelectSession(session)}>
        <span className="sidebar-discovery-row-heading">
          <span className="sidebar-discovery-title" title={title}>{title}</span>
          {runningSessionIds.has(session.id)
            ? <RunningSessionIndicator size={12} />
            : exited
              ? <ExitedSessionIndicator title={formatExitedSessionNotice(exited)} size={12} />
              : unreadSessionIds.has(session.id) ? <UnreadSessionIndicator size={11} /> : null}
        </span>
        <span className="sidebar-discovery-workspace" title={workspace}>{workspace}</span>
        {match && <span className="sidebar-discovery-excerpt">{match.role && <span className="sidebar-discovery-role">{t(match.role === "user" ? "sessionSidebar.matchUser" : "sessionSidebar.matchAssistant")} </span>}{match.excerpt}</span>}
      </button>
    );
  }

  const notices = <>
    {current.loading && <p className="sidebar-discovery-notice" role="status">{t(query ? "sessionSidebar.searching" : "sessionSidebar.recentsLoading")}</p>}
    {current.error && <div className="sidebar-discovery-notice sidebar-discovery-error" role="alert"><span>{t(query ? "sessionSidebar.searchFailed" : "sessionSidebar.recentsFailed")}</span><button type="button" className="load-retry-button sidebar-discovery-action" onClick={() => loadPage(current.failedOffset)}>{t("sessionSidebar.discoveryRetry")}</button></div>}
    {current.unavailable > 0 && <p className="sidebar-discovery-notice" role="status">{tn("sessionSidebar.discoveryUnavailable", current.unavailable)}</p>}
  </>;

  return <>
    <div className="sidebar-discovery-toolbar">
      <div className="sidebar-discovery-search-field">
        <Search size={15} strokeWidth={1.9} aria-hidden="true" />
        <input ref={inputRef} className="sidebar-session-search" type="search" autoComplete="off" spellCheck={false} value={input} onChange={event => changeQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); changeQuery(""); } }} placeholder={t("sessionSidebar.searchPlaceholder")} aria-label={t("sessionSidebar.search")} />
        {input && <button type="button" className="sidebar-discovery-clear" aria-label={t("sessionSidebar.clearSearch")} onClick={() => { changeQuery(""); inputRef.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}
      </div>
      <SidebarIconButton label={t("sessionSidebar.filterRunning")} title={t("sessionSidebar.filterRunningTitle")} active={runningOnly} onClick={onRunningOnlyChange}><SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" /></SidebarIconButton>
    </div>
    <div ref={scrollRef} className="sidebar-discovery-scroll">
      {query ? <section aria-label={t("sessionSidebar.searchResults")}>
        <div className="sidebar-discovery-section-heading" aria-live="polite">{t("sessionSidebar.searchResults")}{!current.loading && !current.error && <span className="sidebar-discovery-count">{current.total}</span>}</div>
        {visibleResults.map(result => row(result.session, result))}
        {notices}
        {!current.loading && !current.error && visibleResults.length === 0 && <p className="sidebar-discovery-notice">{t(runningOnly ? "sessionSidebar.noRunningMatches" : current.unavailable ? "sessionSidebar.noReadableMatches" : "sessionSidebar.noMatches")}</p>}
        {current.hasMore && <button type="button" className="sidebar-discovery-action sidebar-discovery-more" disabled={current.loading} onClick={() => loadPage(current.nextOffset)}>{t("sessionSidebar.loadMore")}</button>}
      </section> : <>
        <section className="sidebar-discovery-recents">
          <button type="button" className="sidebar-discovery-recents-toggle" aria-expanded={recentsExpanded} aria-controls={recentsId} onClick={() => setRecentsExpanded(value => !value)}>
            <ChevronRight size={13} aria-hidden="true" style={{ transform: recentsExpanded ? "rotate(90deg)" : undefined }} />
            <span>{t("sessionSidebar.recents")}</span>
            {!current.loading && !current.error && <span className="sidebar-discovery-count">{visibleRecents.length}</span>}
          </button>
          {recentsExpanded && <div id={recentsId} role="region" aria-label={t("sessionSidebar.recents")}>
            {visibleRecents.map(session => row(session))}
            {notices}
            {!current.loading && !current.error && visibleRecents.length === 0 && <p className="sidebar-discovery-notice">{t(runningOnly ? "sessionSidebar.noRunningRecents" : "sessionSidebar.noRecents")}</p>}
          </div>}
        </section>
        {children}
      </>}
    </div>
  </>;
}
