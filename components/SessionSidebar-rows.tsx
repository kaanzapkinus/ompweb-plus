"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { AgentMessage, ExitedRpcSession, ManagedProject, ProjectLaunchConfig, SessionFolder, SessionInfo } from "@/lib/types";
import { formatExitedSessionNotice, useI18n } from "@/lib/i18n";
import { ChevronDown, ChevronRight, Folder, FolderPlus, GitBranch, MoreHorizontal } from "lucide-react";
import { Tooltip } from "./ui/primitives";
import { ConfirmDialog } from "./ui/field";
import { comparableProjectPath } from "@/lib/comparable-path";
import { copyText } from "@/lib/clipboard";
import { transcriptToMarkdown } from "@/lib/transcript";
import { toast } from "./ui/toast";
import {
  MAX_PROJECT_SESSIONS,
  formatRelativeTime,
  projectLabel,
  type SessionTreeNode,
} from "./SessionSidebar-helpers";
import {
  ExitedSessionIndicator,
  RunningSessionIndicator,
  SIDEBAR_BUTTON_TRANSITION,
  SidebarPortalMenu,
  UnreadSessionIndicator,
} from "./SessionSidebar-chrome";
import { bindSessionFolderActions, groupSessionTreeByFolder } from "./SessionSidebar-folder-groups";
import { FolderNameDialog, FolderRow, MoveToFolderDialog, requestSessionFolder } from "./SessionSidebar-folders";

/**
 * Shared indicator sizing; session rows keep theirs in the right-edge column.
 *
 * Keep the session indicator outside the timestamp and action controls so it
 * stays visible while the menu is open.
 */
const SIDEBAR_STATUS_SLOT = 12;
const SIDEBAR_STATUS_GAP = 2;

interface ProjectRowProps {
  project: ManagedProject;
  isActive: boolean;
  isExpanded: boolean;
  activity: { running: number; unread: number; exited: number } | undefined;
  tree: SessionTreeNode[];
  /** Sessions beyond the cap (0 when a filter is active — show all matches). */
  hiddenCount: number;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  exitedSessions: Map<string, ExitedRpcSession>;
  relativeTimeNow: number;
  onActivate: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onRemoveProject: (path: string) => void;
  onEditLaunchConfig: (project: ManagedProject) => void;
  onUpdatePresentation: (path: string, updates: { alias?: string | null; sortOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }) => void;
  onDragPathChange: (path: string | null) => void;
  onDropProject: (path: string) => void;
  onMoveProject: (path: string, delta: -1 | 1) => void;
  isDragTarget: boolean;
  removeBusy: boolean;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  /** True for the consolidated temporary-workspaces bucket: read-only, no
   * rename/move/remove/drag, and its sessions are never owned by one path. */
  synthetic?: boolean;
  folders?: SessionFolder[];
  folderAssignments?: Record<string, string>;
  onFoldersChanged?: () => void;
}



/** One project in the sidebar: a card row matching the session items' visual
 *  language, with the project's session tree (capped at MAX_PROJECT_SESSIONS
 *  roots, with a show-more toggle) nested under it when expanded. */
function ProjectRow({
  project,
  isActive,
  isExpanded,
  activity,
  tree,
  hiddenCount,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  exitedSessions,
  relativeTimeNow,
  onActivate,
  onToggleExpand,
  onRemoveProject,
  onEditLaunchConfig,
  onUpdatePresentation,
  onDragPathChange,
  onDropProject,
  onMoveProject,
  isDragTarget,
  removeBusy,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  synthetic = false,
  folders = [],
  folderAssignments = {},
  onFoldersChanged,
}: ProjectRowProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const folderWorkspaceAnchorRef = useRef<HTMLButtonElement>(null);
  const [aliasEditing, setAliasEditing] = useState(false);
  const [aliasValue, setAliasValue] = useState("");
  const aliasInputRef = useRef<HTMLInputElement>(null);
  const aliasCancelRef = useRef(false);

  const startAliasEdit = useCallback(() => {
    setAliasValue(project.alias ?? "");
    setAliasEditing(true);
    setTimeout(() => aliasInputRef.current?.select(), 0);
  }, [project.alias]);

  const commitAliasEdit = useCallback(() => {
    if (aliasCancelRef.current) {
      aliasCancelRef.current = false;
      setAliasEditing(false);
      return;
    }
    const alias = aliasValue.trim();
    setAliasEditing(false);
    if (alias === (project.alias ?? "")) return;
    void onUpdatePresentation(project.path, { alias });
  }, [aliasValue, project.alias, project.path, onUpdatePresentation]);
  const label = project.alias ?? projectLabel(project.path);
  const hasActivity = Boolean(activity && (activity.running > 0 || activity.unread > 0 || activity.exited > 0));
  // Folder view always receives the full tree; only the ungrouped view is capped.
  const projectFolders = useMemo(() => {
    if (!folders || folders.length === 0) return [];
    const comp = comparableProjectPath(project.path);
    return folders
      .filter((f) => comparableProjectPath(f.projectPath) === comp)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [folders, project.path]);
  const directFolders = projectFolders.length > 0 && !synthetic;

  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const toggleFolder = useCallback((fId: string) => {
    setCollapsedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(fId)) next.delete(fId);
      else next.add(fId);
      return next;
    });
  }, []);

  const folderGroups = useMemo(() => groupSessionTreeByFolder(
    tree, projectFolders.map((folder) => folder.id), folderAssignments,
  ), [tree, projectFolders, folderAssignments]);
  const visibleRoots = projectFolders.length === 0 && hiddenCount > 0 && !showAllSessions
    ? tree.slice(0, MAX_PROJECT_SESSIONS)
    : tree;

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<SessionFolder | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<SessionFolder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);

  const handleCreateFolder = useCallback(async (name: string) => {
    const data = await requestSessionFolder("POST", { name, projectPath: project.path });
    onFoldersChanged?.();
    return data.folder;
  }, [project.path, onFoldersChanged]);

  const handleRenameFolder = useCallback(async (folderId: string, name: string) => {
    await requestSessionFolder("PATCH", { action: "rename", folderId, name });
    onFoldersChanged?.();
  }, [onFoldersChanged]);

  const handleDeleteFolder = useCallback(async (folderId: string) => {
    if (deletingFolder) return;
    setDeletingFolder(true);
    setFolderError(null);
    try {
      await requestSessionFolder("PATCH", { action: "delete", folderId });
      setDeleteFolderTarget(null);
      onFoldersChanged?.();
    } catch (cause) {
      setFolderError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeletingFolder(false);
    }
  }, [deletingFolder, onFoldersChanged]);

  const handleAssignSession = useCallback(async (sessionId: string, folderId: string | null) => {
    await requestSessionFolder("PATCH", { action: "assign", sessionId, folderId });
    onFoldersChanged?.();
  }, [onFoldersChanged]);

  const handleCreateFolderAndAssign = useCallback(async (sessionId: string, name: string) => {
    const folder = await handleCreateFolder(name);
    if (!folder?.id) throw new Error("Klasör oluşturuldu ancak kimliği alınamadı. Listeyi yenileyin.");
    await handleAssignSession(sessionId, folder.id);
  }, [handleCreateFolder, handleAssignSession]);

  const renderSessions = (nodes: SessionTreeNode[], depth: number) => nodes.map((node) => (
    <SessionTreeItem
      key={node.session.path}
      node={node}
      selectedSessionId={selectedSessionId}
      runningSessionIds={runningSessionIds}
      unreadSessionIds={unreadSessionIds}
      exitedSessions={exitedSessions}
      relativeTimeNow={relativeTimeNow}
      onSelectSession={onSelectSession}
      onRenamed={onRenamed}
      onSessionDeleted={onSessionDeleted}
      depth={depth}
      projectFolders={projectFolders}
      folderAssignments={folderAssignments}
      separatedParents={folderGroups.separatedParents}
      nativeParentPaths={folderGroups.nativeParentPaths}
      onAssignFolder={synthetic ? undefined : handleAssignSession}
      onCreateFolderAndAssign={synthetic ? undefined : handleCreateFolderAndAssign}
    />
  ));


  return (
    <section className="sidebar-project" data-active={isActive ? "true" : "false"} data-topic-folders={directFolders ? "true" : undefined} data-workspace-path={project.path} style={{ marginBottom: directFolders ? 4 : 12 }}>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={<span style={{ overflowWrap: "anywhere" }}>{t("projects.remove", { name: label })}</span>}
        description={<span style={{ overflowWrap: "anywhere" }}>{t("projects.removeTitle", { name: label })}</span>}
        confirmLabel={t("projects.removeConfirmLabel")}
        cancelLabel={t("sessionSidebar.cancel")}
        danger
        busy={removeBusy}
        onConfirm={() => {
          if (removeBusy) return;
          setConfirmRemove(false);
          onRemoveProject(project.path);
        }}
      />
      <div
        className="sidebar-project-header"
        draggable={!aliasEditing && !synthetic}
        onDragStart={(event) => { event.dataTransfer.setData("text/plain", project.path); event.dataTransfer.effectAllowed = "move"; onDragPathChange(project.path); }}
        onDragOver={(event) => { if (isDragTarget) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={(event) => { event.preventDefault(); onDropProject(project.path); }}
        onDragEnd={() => onDragPathChange(null)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && actionMenuOpen) {
            event.stopPropagation();
            setActionMenuOpen(false);
          }
        }}
        style={{
          display: directFolders && !aliasEditing ? "none" : "flex",
          alignItems: "center",
          gap: 2,
          minHeight: 30,
          margin: 0,
          padding: "0 6px 0 0",
          borderRadius: "var(--radius-control)",
          background: isActive
            ? (hovered ? "var(--bg-hover)" : "var(--bg-subtle)")
            : (hovered ? "var(--bg-hover)" : "transparent"),
          transition: SIDEBAR_BUTTON_TRANSITION,
          ...(isDragTarget ? { outline: "1px solid var(--accent)", outlineOffset: -1 } : {}),
        }}
      >
        <div style={{ flex: 1, minWidth: 0, alignSelf: "stretch", display: "flex", alignItems: "center", gap: SIDEBAR_STATUS_GAP }}>
          {aliasEditing ? (
            <div
              className="sidebar-project-identity"
              onClick={(event) => event.stopPropagation()}
              style={{
                flex: 1,
                minWidth: 0,
                alignSelf: "stretch",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "0 4px 0 10px",
              }}
            >
              <Folder
                size={15}
                strokeWidth={1.8}
                style={{ flexShrink: 0, color: "var(--text-muted)" }}
                aria-hidden="true"
              />
              <input
                ref={aliasInputRef}
                autoFocus
                aria-label={t("projects.aliasPrompt")}
                value={aliasValue}
                onChange={(event) => setAliasValue(event.target.value)}
                onBlur={commitAliasEdit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitAliasEdit();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    aliasCancelRef.current = true;
                    setAliasEditing(false);
                  }
                }}
                style={{ flex: 1, minWidth: 0, height: 22, padding: "2px 6px", border: "1px solid var(--accent)", borderRadius: "var(--radius-control)", outline: "none", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 600 }}
              />
            </div>
          ) : (
            <Tooltip
              content={(
                <span style={{ display: "grid", gap: 3, maxWidth: 360, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  <strong style={{ fontFamily: "inherit", fontSize: 11 }}>{t("sessionSidebar.launchConfigDirectory")}</strong>
                  <span>{project.path}</span>
                  {project.launchConfig?.profile && <span>profile: {project.launchConfig.profile}</span>}
                  {project.launchConfig?.advisor && <span>--advisor</span>}
                  {project.launchConfig?.extraArgs?.map((arg, index) => <span key={`${arg}-${index}`}>{arg}</span>)}
                </span>
              )}
              side="right"
            >
            <button
              className="sidebar-project-identity"
              onClick={() => onActivate(project.path)}
              aria-current={isActive ? "true" : undefined}
              title={project.path}
              style={{
                flex: "0 1 auto",
                minWidth: 0,
                alignSelf: "stretch",
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "0 4px 0 10px",
                background: "none", border: "none",
                color: isActive ? "var(--text)" : hovered ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <Folder
                size={15}
                strokeWidth={1.8}
                style={{ flexShrink: 0, color: isActive ? "var(--accent)" : hovered ? "var(--text-muted)" : "var(--text-dim)", transition: "color var(--dur-fast) var(--ease-out-warm)" }}
                aria-hidden="true"
              />
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  lineHeight: 1.25,
                }}
              >
                {label}
              </span>
            </button>
            </Tooltip>
          )}
            {hasActivity && (
              <span
                aria-label={t("projects.activity", { running: activity?.running ?? 0, unread: activity?.unread ?? 0, exited: activity?.exited ?? 0 })}
                title={t("projects.activity", { running: activity?.running ?? 0, unread: activity?.unread ?? 0, exited: activity?.exited ?? 0 })}
                className="sidebar-project-activity"
                data-running={(activity?.running ?? 0) > 0 ? "true" : "false"}
                role="status"
                aria-live="polite"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: SIDEBAR_STATUS_SLOT, height: SIDEBAR_STATUS_SLOT, flexShrink: 0, lineHeight: 0 }}
              >
                {(activity?.exited ?? 0) > 0 ? (
                  <ExitedSessionIndicator title={t("projects.exited", { count: activity?.exited ?? 0 })} size={11} />
                ) : (
                  <span
                    aria-hidden="true"
                    className="sidebar-project-activity-dot"
                    style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--accent)" }}
                  />
                )}
              </span>
            )}
        </div>
        {!synthetic && (
        <div
          className="sidebar-project-actions"
          style={{
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            ref={actionButtonRef}
            className="sidebar-project-action"
            onClick={() => setActionMenuOpen((open) => !open)}
            disabled={removeBusy}
            aria-label={t("commandPalette.actions")}
            title={t("commandPalette.actions")}
            aria-expanded={actionMenuOpen}
            aria-haspopup="menu"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, border: "none", borderRadius: "var(--radius-control)", background: actionMenuOpen ? "var(--bg-selected)" : "transparent", color: "var(--text-dim)", cursor: removeBusy ? "default" : "pointer", opacity: removeBusy ? 0.5 : 1, lineHeight: 0, transition: SIDEBAR_BUTTON_TRANSITION }}
          >
            <MoreHorizontal size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <SidebarPortalMenu
            anchor={directFolders && !aliasEditing ? folderWorkspaceAnchorRef : actionButtonRef}
            open={actionMenuOpen}
            onClose={() => setActionMenuOpen(false)}
            placement="below"
            minWidth={136}
          >
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { startAliasEdit(); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {project.alias ? t("projects.editAlias") : t("projects.nameAlias")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { onEditLaunchConfig(project); setActionMenuOpen(false); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {project.launchConfig ? t("sessionSidebar.editLaunchConfig") : t("sessionSidebar.configureLaunchConfig")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { setActionMenuOpen(false); void onMoveProject(project.path, -1); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.moveUp")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" onClick={() => { setActionMenuOpen(false); void onMoveProject(project.path, 1); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.moveDown")}
            </button>
            <button type="button" role="menuitem" className="sidebar-menu-item" disabled={removeBusy} onClick={() => { setActionMenuOpen(false); setConfirmRemove(true); }} style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--status-error)", cursor: removeBusy ? "default" : "pointer", textAlign: "left", fontSize: 11 }}>
              {t("projects.remove", { name: label })}
            </button>
          </SidebarPortalMenu>
        </div>
        )}
        <button
          className="sidebar-project-toggle"
          onClick={() => onToggleExpand(project.path)}
          aria-label={isExpanded ? t("projects.collapseProject", { name: label }) : t("projects.expandProject", { name: label })}
          aria-expanded={isExpanded}
          title={isExpanded ? t("projects.collapseProjectTitle", { path: project.path }) : t("projects.expandProjectTitle", { path: project.path })}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 22, height: 26, padding: 0, flexShrink: 0,
            background: "none", border: "none",
            color: "var(--text-dim)", cursor: "pointer", lineHeight: 0,
            borderRadius: "var(--radius-control)",
            transition: "color var(--dur-fast) var(--ease-out-warm)",
          }}
        >
          <ChevronRight
            size={13}
            strokeWidth={1.8}
            style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}
            aria-hidden="true"
          />
        </button>
      </div>

      {(directFolders || isExpanded) && (
        <div className="sidebar-project-sessions" style={{ margin: "2px 0 0" }}>
          {projectFolders.map((folder) => {
            const nodes = folderGroups.byFolder.get(folder.id) ?? [];
            const expanded = !collapsedFolderIds.has(folder.id);
            return (
              <div key={folder.id} style={{ margin: "2px 0" }}>
                <FolderRow
                  folder={folder}
                  isExpanded={expanded}
                  onToggleExpand={() => { onActivate(project.path); toggleFolder(folder.id); }}
                  count={folderGroups.counts.get(folder.id) ?? 0}
                  onRename={setRenameFolderTarget}
                  onDelete={(target) => { setFolderError(null); setDeleteFolderTarget(target); }}
                  workspacePath={project.path}
                  onWorkspaceActions={(anchor) => { folderWorkspaceAnchorRef.current = anchor; setActionMenuOpen(true); }}
                />
                {expanded && (nodes.length > 0 ? renderSessions(nodes, 1) : (
                  <div style={{ padding: "4px 8px 4px 38px", color: "var(--text-dim)", fontSize: 11 }}>Boş klasör</div>
                ))}
              </div>
            );
          })}
          {projectFolders.length > 0 ? (
            folderGroups.unassignedCount > 0 && <div style={{ margin: "6px 0 2px" }}>
              <div style={{ padding: "4px 8px 3px 20px", fontSize: 11, color: "var(--text-dim)" }}>
                Klasörsüz ({folderGroups.unassignedCount})
              </div>
              {renderSessions(folderGroups.unassigned, 0)}
            </div>
          ) : renderSessions(visibleRoots, 0)}
          {tree.length === 0 && (
            <div style={{ padding: "6px 12px 8px 34px", color: "var(--text-dim)", fontSize: 11 }}>{t("projects.emptyProject")}</div>
          )}
          {projectFolders.length === 0 && hiddenCount > 0 && (
            <button type="button" className="sidebar-new-folder-btn" onClick={() => setShowAllSessions((value) => !value)} aria-expanded={showAllSessions}>
              <ChevronDown size={12} aria-hidden="true" style={{ transform: showAllSessions ? "rotate(180deg)" : "none" }} />
              {showAllSessions ? t("projects.showLess") : t("projects.showMoreSessions", { count: hiddenCount })}
            </button>
          )}
          {!synthetic && (
            <button type="button" className="sidebar-new-folder-btn" title={`Yeni klasör: ${project.path}`} onClick={() => setNewFolderOpen(true)}>
              <FolderPlus size={12} aria-hidden="true" /><span>Yeni Klasör</span>
            </button>
          )}
        </div>
      )}
      {newFolderOpen && <FolderNameDialog
        title="Yeni Klasör Oluştur"
        onClose={() => setNewFolderOpen(false)}
        onSave={async (name) => { await handleCreateFolder(name); }}
      />}
      {renameFolderTarget && <FolderNameDialog
        key={renameFolderTarget.id}
        title="Klasörü Yeniden Adlandır"
        initialName={renameFolderTarget.name}
        onClose={() => setRenameFolderTarget(null)}
        onSave={(name) => handleRenameFolder(renameFolderTarget.id, name)}
      />}

      <ConfirmDialog
        open={deleteFolderTarget !== null}
        onOpenChange={(open) => { if (!open && !deletingFolder) setDeleteFolderTarget(null); }}
        title={`"${deleteFolderTarget?.name}" Klasörünü Sil`}
        description={<>
          Klasör silinecek. İçindeki chat&apos;ler silinmez, klasörsüz alana taşınır.
          {folderError && <span role="alert" className="sidebar-folder-error" style={{ display: "block" }}>{folderError}</span>}
        </>}
        confirmLabel="Klasörü Sil"
        cancelLabel="İptal"
        danger
        busy={deletingFolder}
        onConfirm={() => {
          if (deleteFolderTarget) void handleDeleteFolder(deleteFolderTarget.id);
        }}
      />

    </section>
  );
}
const SessionTreeItem = memo(function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  exitedSessions,
  relativeTimeNow,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  projectFolders,
  folderAssignments,
  separatedParents,
  nativeParentPaths,
  onAssignFolder,
  onCreateFolderAndAssign,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  exitedSessions: Map<string, ExitedRpcSession>;
  relativeTimeNow: number;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  projectFolders?: SessionFolder[];
  folderAssignments?: Record<string, string>;
  separatedParents?: Map<string, SessionInfo>;
  nativeParentPaths?: Set<string>;
  onAssignFolder?: (sessionId: string, folderId: string | null) => Promise<void>;
  onCreateFolderAndAssign?: (sessionId: string, name: string) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;
  const sessionId = node.session.id;
  const assignedFolder = folderAssignments?.[sessionId];
  const currentFolderId = projectFolders?.some((folder) => folder.id === assignedFolder) ? assignedFolder : undefined;
  const separatedParent = separatedParents?.get(node.session.path);
  const folderActions = useMemo(() => bindSessionFolderActions(
    sessionId, onAssignFolder, onCreateFolderAndAssign,
  ), [sessionId, onAssignFolder, onCreateFolderAndAssign]);

  // Pre-compute the booleans so SessionItem only sees primitives — its memo
  // check then never re-renders unless this row's flags actually changed.
  const isSelected = sessionId === selectedSessionId;
  const isRunning = runningSessionIds.has(sessionId);
  const isUnread = unreadSessionIds.has(sessionId);
  const exited = exitedSessions.get(sessionId);

  // Stable callbacks: depend only on primitives / stable parent callbacks so
  // SessionItem's React.memo stays effective across re-renders.
  const handleClick = useCallback(() => {
    onSelectSession(node.session);
  }, [onSelectSession, node.session]);
  const handleDeleted = useCallback((id: string) => {
    onSessionDeleted?.(id);
  }, [onSessionDeleted]);
  const handleToggleCollapse = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  return (
    <div>
      {separatedParent && (
        <button type="button" className="sidebar-fork-parent" onClick={() => onSelectSession(separatedParent)} title={separatedParent.name || separatedParent.id}>
          <GitBranch size={11} aria-hidden="true" />
          <span>Üst sohbet: {separatedParent.name || separatedParent.firstMessage || separatedParent.id}</span>
        </button>
      )}
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 14 + 22,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={isSelected}
          isRunning={isRunning}
          isUnread={isUnread}
          exited={exited}
          relativeTimeNow={relativeTimeNow}
          onClick={handleClick}
          onRenamed={onRenamed}
          onDeleted={handleDeleted}
          depth={depth}
          hasChildren={hasChildren}
          hasNativeChildren={nativeParentPaths?.has(node.session.path)}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
          projectFolders={projectFolders}
          currentFolderId={currentFolderId}
          {...folderActions}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.path}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              exitedSessions={exitedSessions}
              relativeTimeNow={relativeTimeNow}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              projectFolders={projectFolders}
              folderAssignments={folderAssignments}
              separatedParents={separatedParents}
              nativeParentPaths={nativeParentPaths}
              onAssignFolder={onAssignFolder}
              onCreateFolderAndAssign={onCreateFolderAndAssign}
            />
          ))}
        </div>
      )}
    </div>
  );
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
  projectFolders,
  currentFolderId,
  onAssignFolder,
  onCreateFolderAndAssign,
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
  projectFolders?: SessionFolder[];
  currentFolderId?: string;
  onAssignFolder?: (folderId: string | null) => Promise<void>;
  onCreateFolderAndAssign?: (name: string) => Promise<void>;
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
  const [moveToFolderOpen, setMoveToFolderOpen] = useState(false);
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
                  {onAssignFolder && (
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-menu-item"
                      onClick={(event) => {
                        event.stopPropagation();
                        setActionMenuOpen(false);
                        setMoveToFolderOpen(true);
                      }}
                      style={{ display: "block", width: "100%", padding: "6px 9px", border: "none", borderRadius: 6, background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 11 }}
                    >
                      📁 Klasöre Taşı...
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
      {onAssignFolder && moveToFolderOpen && (
        <MoveToFolderDialog
          onClose={() => setMoveToFolderOpen(false)}
          session={session}
          projectFolders={projectFolders ?? []}
          currentFolderId={currentFolderId}
          onAssign={onAssignFolder}
          onCreateFolderAndAssign={onCreateFolderAndAssign}
        />
      )}

    </>
  );
});
export {
  ProjectRow,
  SessionItem,
  SessionTreeItem,
  type ProjectRowProps,
};
