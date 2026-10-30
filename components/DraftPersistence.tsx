"use client";

import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { ConfirmDialog } from "./ui/field";
import { useI18n } from "@/lib/i18n";
import { deleteRemoteDraft, getDraftSyncState, listRemoteDraftHistory, resolveRemoteDraftConflict, restoreRemoteDraft, subscribeDraftSync } from "@/lib/durable-draft-client";
import type { DraftVersion } from "@/lib/durable-draft-types";

/** Shared by the normal composer and its separately owned scheduling draft. */
export function DraftPersistence({ draftKey }: { draftKey: string }) {
  const { locale, t } = useI18n();
  const [, refresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setExpanded(false);
    setVersions([]);
    setError(null);
    setBusy(false);
    setConfirmDelete(false);
    const unsubscribe = subscribeDraftSync(draftKey, () => refresh(value => value + 1));
    return () => { generation.current++; unsubscribe(); };
  }, [draftKey]);
  const sync = getDraftSyncState(draftKey);
  const labels = {
    loading: t("durableDraft.loading"),
    saving: t(sync.uploading ? "durableDraft.uploading" : "durableDraft.saving"),
    saved: t("durableDraft.saved"),
    offline: t("durableDraft.offline"),
    conflict: t("durableDraft.conflict"),
    error: t("durableDraft.error"),
  };
  const action = async (run: () => Promise<void>) => {
    const current = generation.current;
    setBusy(true);
    setError(null);
    try { await run(); }
    catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current === current) setBusy(false); }
  };
  const loadHistory = () => action(async () => {
    const current = generation.current;
    const result = await listRemoteDraftHistory(draftKey);
    if (generation.current === current) setVersions(result);
  });
  return <div className="draft-persistence">
    <div className="draft-persistence-status">
      <span role="status" aria-live="polite">{labels[sync.status]}</span>
      <button type="button" aria-expanded={expanded} disabled={busy} onClick={() => {
        setExpanded(!expanded);
        if (!expanded) void loadHistory();
      }}><History size={13} aria-hidden="true" />{t("durableDraft.history")}</button>
    </div>
    {(error || sync.error) && <p role="alert">{error || sync.error}</p>}
    {sync.status === "conflict" && <div className="draft-persistence-actions">
      <button type="button" disabled={busy} onClick={() => void action(() => resolveRemoteDraftConflict(draftKey, "local"))}>{t("durableDraft.keepLocal")}</button>
      <button type="button" disabled={busy} onClick={() => void action(() => resolveRemoteDraftConflict(draftKey, "server"))}>{t("durableDraft.useServer")}</button>
    </div>}
    {expanded && <section aria-label={t("durableDraft.history")} className="draft-history">
      <p>{t("durableDraft.historyHint")}</p>
      {busy && <p role="status">{t("durableDraft.loading")}</p>}
      {!busy && versions.length === 0 && <p>{t("durableDraft.emptyHistory")}</p>}
      <ol>{versions.map(version => <li key={version.revision}>
        <div><time dateTime={version.updatedAt}>{new Date(version.updatedAt).toLocaleString(locale)}</time>
          {version.reason === "conflict" && <span> · {t("durableDraft.conflictingEdit")}</span>}
          {version.reason === "clear" && <span> · {t("durableDraft.cleared")}</span>}
          <p>{version.preview || t("durableDraft.empty")}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void action(async () => {
          const currentGeneration = generation.current;
          await restoreRemoteDraft(draftKey, version.revision);
          const result = await listRemoteDraftHistory(draftKey);
          if (generation.current === currentGeneration) setVersions(result);
        })}>{t("durableDraft.restore")}</button>
      </li>)}</ol>
      <div className="draft-persistence-actions">
        <button type="button" disabled={busy} onClick={() => void loadHistory()}>{t("durableDraft.refresh")}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>{t("durableDraft.delete")}…</button>
      </div>
    </section>}
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={t("durableDraft.deleteTitle")}
      description={t("durableDraft.deleteDescription")}
      confirmLabel={t("durableDraft.delete")} cancelLabel={t("chatInput.cancel")} danger busy={busy}
      onConfirm={() => void action(async () => {
        const current = generation.current;
        await deleteRemoteDraft(draftKey);
        if (generation.current === current) { setConfirmDelete(false); setVersions([]); }
      })} />
  </div>;
}
