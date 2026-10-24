"use client";

import { useRef, useState } from "react";
import type { SessionFolder, SessionInfo } from "@/lib/types";
import { Check, ChevronRight, Folder, MoreHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { SidebarPortalMenu } from "./SessionSidebar-chrome";

export async function requestSessionFolder(method: "POST" | "PATCH", body: object) {
  const res = await fetch("/api/session-folders", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
  return data as { folder?: SessionFolder };
}

export function FolderRow({ folder, isExpanded, onToggleExpand, count, onRename, onDelete, workspacePath, onWorkspaceActions }: {
  folder: SessionFolder;
  isExpanded: boolean;
  onToggleExpand: () => void;
  count: number;
  onRename: (folder: SessionFolder) => void;
  onDelete: (folder: SessionFolder) => void;
  workspacePath: string;
  onWorkspaceActions: (anchor: HTMLButtonElement) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="sidebar-folder-row">
      <button type="button" className="sidebar-folder-toggle" title={`${folder.name} — ${workspacePath}`} aria-expanded={isExpanded} onClick={onToggleExpand}>
        <ChevronRight size={12} aria-hidden="true" style={{ flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "none" }} />
        <Folder size={13} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />
        <span className="sidebar-folder-name">{folder.name}</span>
        <span className="sidebar-folder-count">({count})</span>
      </button>
      <button ref={anchor} type="button" className="sidebar-folder-menu" aria-label={`${folder.name}: Klasör İşlemleri`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      <SidebarPortalMenu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} placement="below">
        <button type="button" role="menuitem" className="sidebar-menu-item sidebar-folder-menu-item" onClick={() => { setMenuOpen(false); onRename(folder); }}>Yeniden Adlandır</button>
        <button type="button" role="menuitem" className="sidebar-menu-item sidebar-folder-menu-item" onClick={() => { setMenuOpen(false); onDelete(folder); }}>Klasörü Sil</button>
        <button type="button" role="menuitem" className="sidebar-menu-item sidebar-folder-menu-item" title={workspacePath} onClick={() => { setMenuOpen(false); if (anchor.current) onWorkspaceActions(anchor.current); }}>Kaynak çalışma alanı işlemleri</button>
      </SidebarPortalMenu>
    </div>
  );
}

/** Keep the user's name and the dialog open until the server confirms success. */
export function FolderNameDialog({ title, initialName = "", onClose, onSave }: {
  title: string;
  initialName?: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending.current) onClose(); }}>
      <DialogContent className="sidebar-folder-dialog">
        <DialogTitle>{title}</DialogTitle>
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current || !name.trim()) return;
          pending.current = true;
          setBusy(true);
          setError(null);
          try { await onSave(name.trim()); onClose(); }
          catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
          finally { pending.current = false; setBusy(false); }
        }}>
          <label>Klasör adı<input autoFocus value={name} maxLength={200} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
          {error && <p role="alert" className="sidebar-folder-error">{error}</p>}
          <div className="sidebar-folder-dialog-actions">
            <button type="button" disabled={busy} onClick={onClose}>İptal</button>
            <button type="submit" disabled={busy || !name.trim()}>{busy ? "Kaydediliyor…" : "Kaydet"}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MoveToFolderDialog({ onClose, session, projectFolders, currentFolderId, onAssign, onCreateFolderAndAssign }: {
  onClose: () => void;
  session: SessionInfo;
  projectFolders: SessionFolder[];
  currentFolderId?: string;
  onAssign: (folderId: string | null) => Promise<void>;
  onCreateFolderAndAssign?: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const save = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try { await operation(); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending.current) onClose(); }}>
      <DialogContent className="sidebar-folder-dialog">
        <DialogTitle>Klasöre Taşı</DialogTitle>
        <p className="sidebar-folder-session-title">{session.name || session.firstMessage || session.id}</p>
        <div className="sidebar-folder-choices" aria-label="Klasörler">
          {[{ id: "", name: "Klasörsüz" }, ...projectFolders].map((folder) => (
            <button key={folder.id} type="button" disabled={busy} aria-pressed={folder.id === (currentFolderId ?? "")} onClick={() => void save(() => onAssign(folder.id || null))}>
              <span>{folder.name}</span>{folder.id === (currentFolderId ?? "") && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
        {onCreateFolderAndAssign && <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void save(() => onCreateFolderAndAssign(name.trim())); }}>
          <label>Yeni klasör adı<input value={name} maxLength={200} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
          <div className="sidebar-folder-dialog-actions"><button type="submit" disabled={busy || !name.trim()}>Oluştur ve Taşı</button></div>
        </form>}
        {error && <p role="alert" className="sidebar-folder-error">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
