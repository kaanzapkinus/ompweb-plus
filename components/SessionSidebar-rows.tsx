"use client";

import { memo, useCallback, useRef, useState } from "react";
import type { AgentMessage, ExitedRpcSession, ManagedProject, SessionInfo, Workspace } from "@/lib/types";
import { formatExitedSessionNotice, useI18n } from "@/lib/i18n";
import { ChevronDown, ChevronRight, Folder, GitBranch, MoreHorizontal, Plus } from "lucide-react";
import { Tooltip } from "./ui/primitives";
import { ConfirmDialog } from "./ui/field";
import { copyText } from "@/lib/clipboard";
import { transcriptToMarkdown } from "@/lib/transcript";
import { toast } from "./ui/toast";
import {
  formatRelativeTime,
  type SessionTreeNode,
} from "./SessionSidebar-helpers";
import {
  ExitedSessionIndicator,
  RunningSessionIndicator,
  SIDEBAR_BUTTON_TRANSITION,
  SidebarPortalMenu,
  UnreadSessionIndicator,
} from "./SessionSidebar-chrome";
import { MoveToWorkspaceDialog, WorkspaceNameDialog } from "./SessionSidebar-workspaces";

/**
 * Shared indicator sizing; session rows keep theirs in the right-edge column.
 *
 * Keep the session indicator outside the timestamp and action controls so it
 * stays visible while the menu is open.
 */
const SIDEBAR_STATUS_SLOT = 12;
const SIDEBAR_STATUS_GAP = 2;

interface WorkspaceRowProps {
  workspace: Workspace;
  project: ManagedProject;
  workspaces: Workspace[];
  assignments: Record<string, string>;
  isActive: boolean;
  isExpanded: boolean;
  tree: SessionTreeNode[];
  nativeParentIds: Set<string>;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  exitedSessions: Map<string, ExitedRpcSession>;
  relativeTimeNow: number;
  onActivate: (workspace: Workspace) => void;
  onNewSession: (workspace: Workspace) => void;
  onToggleExpand: (id: string) => void;
  onRemoveWorkspace: (id: string) => Promise<void>;
  onRenameWorkspace: (id: string, name: string) => Promise<void>;
  onAssignWorkspace: (sessionId: string, workspaceId: string | null) => Promise<void>;
  onEditLaunchConfig: (project: ManagedProject) => void;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
}

function WorkspaceRow(props: WorkspaceRowProps) {
  const { workspace, project, isActive, isExpanded, tree, onActivate, onNewSession, onToggleExpand, onRemoveWorkspace, onRenameWorkspace, onEditLaunchConfig } = props;
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  return <section className="sidebar-project" data-active={isActive ? "true" : "false"} data-workspace-id={workspace.id} style={{ marginBottom: 12 }}>
    <div className="sidebar-project-header" style={{ display: "flex", alignItems: "center", gap: 2, minHeight: 30, padding: "0 6px 0 0", background: isActive ? "var(--bg-subtle)" : "transparent", borderRadius: "var(--radius-control)" }}>
      <Tooltip content={workspace.cwd} side="right">
        <button type="button" className="sidebar-project-identity" aria-current={isActive ? "true" : undefined} onClick={() => onActivate(workspace)} style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0, padding: "0 4px 0 10px", background: "none", border: "none", color: isActive ? "var(--text)" : "var(--text-muted)", cursor: "pointer", textAlign: "left" }}>
          <Folder size={15} aria-hidden="true" style={{ flexShrink: 0, color: isActive ? "var(--accent)" : "var(--text-dim)" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600 }}>{workspace.name}</span>
        </button>
      </Tooltip>
      <button type="button" className="sidebar-project-action" aria-label={t("workspaces.newChat", { name: workspace.name })} title={t("workspaces.newChat", { name: workspace.name })} onClick={() => onNewSession(workspace)}><Plus size={13} aria-hidden="true" /></button>
      <button ref={anchor} type="button" className="sidebar-project-action" aria-label={`${workspace.name}: ${t("projects.actions")}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}><MoreHorizontal size={13} aria-hidden="true" /></button>
      <SidebarPortalMenu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} placement="below">
        <button type="button" role="menuitem" className="sidebar-menu-item sidebar-folder-menu-item" onClick={() => { setMenuOpen(false); setRenaming(true); }}>{t("workspaces.rename")}</button>
        <button type="button" role="menuitem" className="sidebar-menu-item sidebar-folder-menu-item" onClick={() => { setMenuOpen(false); onEditLaunchConfig(project); }}>{project.launchConfig ? t("sessionSidebar.editLaunchConfig") : t("sessionSidebar.configureLaunchConfig")}</button>
        <button type="button" role="menuitem" className="sidebar-menu-item sidebar-folder-menu-item" onClick={() => { setMenuOpen(false); setError(null); setRemoving(true); }}>{t("workspaces.remove")}</button>
      </SidebarPortalMenu>
      <button type="button" className="sidebar-project-toggle" onClick={() => onToggleExpand(workspace.id)} aria-label={isExpanded ? t("projects.collapseProject", { name: workspace.name }) : t("projects.expandProject", { name: workspace.name })} aria-expanded={isExpanded} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 26, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>
        <ChevronRight size={13} aria-hidden="true" style={{ transform: isExpanded ? "rotate(90deg)" : "none" }} />
      </button>
    </div>
    {isExpanded && <div className="sidebar-project-sessions" style={{ margin: "2px 0 0" }}>
      {tree.map(node => <SessionTreeItem key={node.session.path || node.session.id} node={node} selectedSessionId={props.selectedSessionId} runningSessionIds={props.runningSessionIds} unreadSessionIds={props.unreadSessionIds} exitedSessions={props.exitedSessions} relativeTimeNow={props.relativeTimeNow} onSelectSession={props.onSelectSession} onRenamed={props.onRenamed} onSessionDeleted={props.onSessionDeleted} depth={0} workspaces={props.workspaces} assignments={props.assignments} nativeParentIds={props.nativeParentIds} onAssignWorkspace={props.onAssignWorkspace} />)}
      {tree.length === 0 && <div style={{ padding: "6px 12px 8px 34px", color: "var(--text-dim)", fontSize: 11 }}>{t("workspaces.empty")}</div>}
    </div>}
    {renaming && <WorkspaceNameDialog title={t("workspaces.rename")} initialName={workspace.name} onClose={() => setRenaming(false)} onSave={name => onRenameWorkspace(workspace.id, name)} />}
    <ConfirmDialog open={removing} onOpenChange={open => { if (!busy) setRemoving(open); }} title={t("workspaces.removeConfirm", { name: workspace.name })} description={<>{t("workspaces.removeDescription")}{error && <span role="alert" style={{ display: "block" }}>{error}</span>}</>} confirmLabel={t("workspaces.remove")} cancelLabel={t("sessionSidebar.cancel")} danger busy={busy} onConfirm={() => {
      if (busy) return;
      setBusy(true);
      void onRemoveWorkspace(workspace.id).then(() => setRemoving(false)).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
    }} />
  </section>;
}

const SessionTreeItem = memo(function SessionTreeItem({ node, selectedSessionId, runningSessionIds, unreadSessionIds, exitedSessions, relativeTimeNow, onSelectSession, onRenamed, onSessionDeleted, depth, workspaces, assignments, nativeParentIds, onAssignWorkspace }: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  exitedSessions: Map<string, ExitedRpcSession>;
  relativeTimeNow: number;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  workspaces?: Workspace[];
  assignments?: Record<string, string>;
  nativeParentIds?: Set<string>;
  onAssignWorkspace?: (sessionId: string, workspaceId: string | null) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const handleClick = useCallback(() => onSelectSession(node.session), [onSelectSession, node.session]);
  const handleAssign = useCallback((workspaceId: string | null) => onAssignWorkspace!(node.session.id, workspaceId), [onAssignWorkspace, node.session.id]);
  const toggle = useCallback(() => setCollapsed(value => !value), []);
  return <div>
    <SessionItem session={node.session} isSelected={node.session.id === selectedSessionId} isRunning={runningSessionIds.has(node.session.id)} isUnread={unreadSessionIds.has(node.session.id)} exited={exitedSessions.get(node.session.id)} relativeTimeNow={relativeTimeNow} onClick={handleClick} onRenamed={onRenamed} onDeleted={onSessionDeleted} depth={depth} hasChildren={node.children.length > 0} hasNativeChildren={nativeParentIds?.has(node.session.id) ?? node.children.length > 0} collapsed={collapsed} onToggleCollapse={toggle} workspaces={workspaces} currentWorkspaceId={assignments?.[node.session.id]} onAssignWorkspace={onAssignWorkspace ? handleAssign : undefined} />
    {!collapsed && node.children.map(child => <SessionTreeItem key={child.session.path || child.session.id} node={child} selectedSessionId={selectedSessionId} runningSessionIds={runningSessionIds} unreadSessionIds={unreadSessionIds} exitedSessions={exitedSessions} relativeTimeNow={relativeTimeNow} onSelectSession={onSelectSession} onRenamed={onRenamed} onSessionDeleted={onSessionDeleted} depth={depth + 1} workspaces={workspaces} assignments={assignments} nativeParentIds={nativeParentIds} onAssignWorkspace={onAssignWorkspace} />)}
  </div>;
});
const SessionItem = memo(function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  exited,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  hasNativeChildren = hasChildren,
  collapsed = false,
  relativeTimeNow,
  onToggleCollapse,
  workspaces,
  currentWorkspaceId,
  onAssignWorkspace,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  exited?: ExitedRpcSession;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  hasNativeChildren?: boolean;
  relativeTimeNow: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  workspaces?: Workspace[];
  currentWorkspaceId?: string;
  onAssignWorkspace?: (workspaceId: string | null) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const exitTitle = exited ? formatExitedSessionNotice(exited) : "";
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameCancelRef = useRef(false);
 const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moveToWorkspaceOpen, setMoveToWorkspaceOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
  const relativeTime = formatRelativeTime(session.modified, locale, relativeTimeNow);
  const rowBackground = isSelected
    ? "color-mix(in srgb, var(--bg-selected) 70%, transparent)"
    : hovered ? "var(--bg-hover)" : "transparent";

  const startRename = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      return;
    }
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("Session rename failed");
      onRenamed?.();
    } catch {
      // The next refresh remains authoritative if the rename fails.
    }
  }, [renameValue, session.id, session.name, onRenamed]);

 const handleArchive = useCallback(async () => {
 setDeleting(true);
 try {
 const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: "POST" });
 if (!response.ok) throw new Error("Session archive failed");
 onDeleted?.(session.id);
 } catch {
 setDeleting(false);
 toast.error(t("sessionSidebar.archiveFailed"));
 }
 }, [session.id, onDeleted, t]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Session deletion failed");
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
      toast.error(t("sessionSidebar.deleteFailed"));
    }
  }, [session.id, onDeleted, t, deleting]);
  const [copyingTranscript, setCopyingTranscript] = useState(false);
  const handleCopyTranscript = useCallback(async () => {
    if (copyingTranscript) return;
    setCopyingTranscript(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`);
      if (!response.ok) throw new Error("Session transcript fetch failed");
      const data = await response.json() as { context?: { messages?: AgentMessage[] }; info?: { cwd?: string } };
      const markdown = transcriptToMarkdown(data.context?.messages ?? [], { title, cwd: data.info?.cwd ?? session.cwd });
      await copyText(markdown);
      toast.success(t("sessionSidebar.copyTranscriptCopied"));
    } catch {
      toast.error(t("sessionSidebar.copyTranscriptFailed"));
    } finally {
      setCopyingTranscript(false);
    }
  }, [copyingTranscript, session.id, session.cwd, title, t]);

 const closeConfirmation = useCallback(() => {
 setConfirmDelete(false);
 setActionMenuOpen(false);
 requestAnimationFrame(() => contentButtonRef.current?.focus());
 }, []);

  return (
    <>
    <div
      className="session-item-row"
      data-session-id={session.id}
      data-session-path={session.path}
      data-parent-session-id={session.parentSessionId}
 onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        if ((confirmDelete || actionMenuOpen) && event.key === "Escape") {
          event.stopPropagation();
          closeConfirmation();
        }
      }}
      style={{
        height: 30,
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        margin: "1px 0",
        padding: `0 8px 0 ${30 + depth * 14}px`,
        position: "relative",
        overflow: "hidden",
        background: rowBackground,
        opacity: deleting ? 0.5 : 1,
        cursor: renaming ? "default" : "pointer",
        transition: "background var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      {isSelected && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 20 + depth * 14,
            top: 0,
            bottom: 0,
            width: 2,
            borderRadius: 1,
            background: "var(--accent)",
            pointerEvents: "none",
          }}
        />
      )}
      {renaming ? (
        <input ref={inputRef} autoFocus aria-label={t("sessionSidebar.rename")} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") void commitRename(); if (event.key === "Escape") { event.preventDefault(); renameCancelRef.current = true; setRenaming(false); } }} style={{ flex: 1, height: 25, padding: "3px 7px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12 }} />
      ) : (
        <>
          {session.parentSessionId && <GitBranch size={11} strokeWidth={2} style={{ flexShrink: 0, color: "var(--text-dim)" }} aria-hidden="true" />}
          <button ref={contentButtonRef} type="button" className="session-item-button" aria-current={isSelected ? "true" : undefined} onKeyDown={(event) => { if (event.key === "Delete" && !deleting) { event.preventDefault(); setConfirmDelete(true); } }} style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
            <span title={title} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12.5, fontWeight: isSelected ? 600 : 500, lineHeight: 1.35, letterSpacing: "-0.005em" }}>
              {title}
            </span>
          </button>
          {session.worktreeBranch && <span title={t("sessionSidebar.worktreeTitle", { path: session.cwd })} style={{ display: "flex", alignItems: "center", gap: 3, maxWidth: 56, minWidth: 0, overflow: "hidden", color: "var(--text-dim)", fontSize: 10, flexShrink: 1 }}><GitBranch size={10} strokeWidth={2.4} aria-hidden="true" /><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span></span>}
          {hasChildren && <button className="session-item-icon-button" onClick={(event) => { event.stopPropagation(); onToggleCollapse?.(); }} title={collapsed ? t("sessionSidebar.expandForks") : t("sessionSidebar.collapseForks")} aria-label={collapsed ? t("sessionSidebar.expandForks") : t("sessionSidebar.collapseForks")} aria-expanded={!collapsed} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, flexShrink: 0, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}><ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" /></button>}
          <div style={{ display: "flex", alignItems: "center", gap: SIDEBAR_STATUS_GAP, flexShrink: 0 }}>
            {(isRunning || exited || isUnread) && (
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: SIDEBAR_STATUS_SLOT, height: SIDEBAR_STATUS_SLOT, flexShrink: 0 }}>
                {isRunning
                  ? <RunningSessionIndicator size={12} />
                  : exited
                    ? <ExitedSessionIndicator title={exitTitle} size={12} />
                    : <UnreadSessionIndicator size={11} />}
              </span>
            )}
            <div className="session-item-trailing" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexShrink: 0 }}>
              <div className="session-item-metadata" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                {relativeTime && <span className="session-item-time" title={new Date(session.modified).toLocaleString(locale)} style={{ flexShrink: 0, whiteSpace: "nowrap", textAlign: "right", color: isSelected ? "var(--accent)" : "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums" }}>{relativeTime}</span>}
              </div>
              <div className="session-item-actions" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
                <button type="button" ref={menuButtonRef} className="session-item-icon-button session-item-menu-button" onClick={(event) => { event.stopPropagation(); setActionMenuOpen((open) => !open); }} title={t("projects.actions")} aria-label={t("projects.actions")} aria-expanded={actionMenuOpen} style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 0, lineHeight: 0, border: "none", borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: actionMenuOpen ? "var(--text)" : "var(--text-dim)", cursor: "pointer" }}>
                  <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <SidebarPortalMenu anchor={menuButtonRef} open={actionMenuOpen} onClose={() => setActionMenuOpen(false)} placement="below" minWidth={128}>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); void handleArchive(); }} disabled={hasNativeChildren} title={hasNativeChildren ? t("sessionSidebar.archiveLeafOnly") : t("sessionSidebar.archive")} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: hasNativeChildren ? "var(--text-dim)" : "var(--text-muted)", cursor: hasNativeChildren ? "not-allowed" : "pointer", textAlign: "left", fontSize: 11, opacity: hasNativeChildren ? 0.55 : 1 }}>{t("sessionSidebar.archive")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { startRename(event); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.rename")}</button>
                  <button type="button" role="menuitem" className="sidebar-menu-item" onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); void handleCopyTranscript(); }} disabled={copyingTranscript} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: copyingTranscript ? "default" : "pointer", textAlign: "left", fontSize: 11, opacity: copyingTranscript ? 0.55 : 1 }}>{t("sessionSidebar.copyTranscript")}</button>
                  {onAssignWorkspace && (
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-menu-item"
                      onClick={(event) => {
                        event.stopPropagation();
                        setActionMenuOpen(false);
                        setMoveToWorkspaceOpen(true);
                      }}
                      style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}
                    >
                      {t("workspaces.move")}
                    </button>
                  )}
                  <button type="button" role="menuitem" className="sidebar-menu-item" disabled={deleting} onClick={(event) => { event.stopPropagation(); setActionMenuOpen(false); setConfirmDelete(true); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>{t("sessionSidebar.delete")}</button>
                </SidebarPortalMenu>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(open) => { if (open) setConfirmDelete(true); else closeConfirmation(); }}
        title={<span style={{ overflowWrap: "anywhere" }}>{t("sessionSidebar.deleteConfirm", { title })}</span>}
        description={t("sessionSidebar.deleteConfirmBody")}
        confirmLabel={t("sessionSidebar.delete")}
        cancelLabel={t("sessionSidebar.cancel")}
        danger
        busy={deleting}
        onConfirm={handleDelete}
      />
      {onAssignWorkspace && moveToWorkspaceOpen && (
        <MoveToWorkspaceDialog
          onClose={() => setMoveToWorkspaceOpen(false)}
          workspaces={workspaces ?? []}
          currentWorkspaceId={currentWorkspaceId}
          onAssign={onAssignWorkspace}
        />
      )}

    </>
  );
});
export {
  WorkspaceRow,
  SessionItem,
  SessionTreeItem,
  type WorkspaceRowProps,
};
