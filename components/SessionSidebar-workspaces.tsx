"use client";

import { useRef, useState } from "react";
import type { Workspace, WorkspacesRegistry } from "@/lib/types";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { useI18n } from "@/lib/i18n";

export async function requestWorkspace(method: "POST" | "PATCH", body: object): Promise<WorkspacesRegistry> {
  const response = await fetch("/api/workspaces", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
  return data;
}

export function WorkspaceSelector({ workspaces, selectedWorkspaceId, cwd, onSelect, onCreate }: {
  workspaces: Workspace[];
  selectedWorkspaceId: string | null;
  cwd: string | null;
  onSelect: (workspace: Workspace) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  return <select id="new-session-workspace" aria-label={t("projects.heading")} aria-describedby="new-session-workspace-path"
    value={selectedWorkspaceId ?? "__directory__"} onChange={event => {
      if (!event.target.value) { onCreate(); return; }
      const workspace = workspaces.find(workspace => workspace.id === event.target.value);
      if (workspace && workspace.id !== selectedWorkspaceId) onSelect(workspace);
    }}>
    {!selectedWorkspaceId && <option value="__directory__" disabled hidden>{cwd}</option>}
    {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    <option value="">+ {t("workspaces.create")}</option>
  </select>;
}

export function WorkspaceNameDialog({ title, initialName = "", onClose, onSave }: {
  title: string;
  initialName?: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  return <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <DialogContent className="sidebar-folder-dialog">
      <DialogTitle>{title}</DialogTitle>
      <form onSubmit={async event => {
        event.preventDefault();
        if (pending.current || !name.trim()) return;
        pending.current = true;
        setBusy(true);
        setError(null);
        try { await onSave(name.trim()); onClose(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { pending.current = false; setBusy(false); }
      }}>
        <label>{t("workspaces.name")}<input autoFocus value={name} maxLength={200} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        {error && <p role="alert" className="sidebar-folder-error">{error}</p>}
        <div className="sidebar-folder-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>{t("sessionSidebar.cancel")}</button>
          <button type="submit" disabled={busy || !name.trim()}>{busy ? t("workspaces.saving") : t("workspaces.save")}</button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function MoveToWorkspaceDialog({ workspaces, currentWorkspaceId, onClose, onAssign }: {
  workspaces: Workspace[];
  currentWorkspaceId?: string;
  onClose: () => void;
  onAssign: (workspaceId: string | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  return <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <DialogContent className="sidebar-folder-dialog">
      <DialogTitle>{t("workspaces.move")}</DialogTitle>
      <p>{t("workspaces.moveDescription")}</p>
      <div className="sidebar-folder-choices" aria-label={t("projects.heading")}>
        {[{ id: "", name: t("workspaces.defaultDirectory") }, ...workspaces].map(workspace => <button
          key={workspace.id} type="button" disabled={busy} aria-pressed={workspace.id === currentWorkspaceId}
          onClick={async () => {
            if (pending.current) return;
            pending.current = true;
            setBusy(true);
            setError(null);
            try { await onAssign(workspace.id || null); onClose(); }
            catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
            finally { pending.current = false; setBusy(false); }
          }}>
          <span>{workspace.name}</span>{workspace.id === currentWorkspaceId && <Check size={14} aria-hidden="true" />}
        </button>)}
      </div>
      {error && <p role="alert" className="sidebar-folder-error">{error}</p>}
    </DialogContent>
  </Dialog>;
}
