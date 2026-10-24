"use client";

import { useEffect, useMemo, useState } from "react";
import { LogOut } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { planForStoredAccount, summarizeProviderAccounts } from "@/lib/provider-accounts";
import { useProviderUsage } from "./AppShell-provider-usage";
import { ConfirmDialog } from "./ui/field";

interface StoredAccount {
  credentialId: number;
  label: string;
  detail: string;
  type: "api_key" | "oauth";
}

/**
 * Accounts omp stores for one provider. omp stays responsible for credentials,
 * account selection and rotation; this lists its stored credentials
 * (`get_logout_accounts`) and removes one through its `logout` RPC. omp
 * releases without that RPC fall back to the read-only list `omp usage` reports.
 */
export function ProviderAccounts({ providerId, enabled, onChanged }: { providerId: string; enabled: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const { snapshot, loading: usageLoading } = useProviderUsage(enabled ? `provider=${encodeURIComponent(providerId)}` : null);
  const usageAccounts = useMemo(
    () => (snapshot ? summarizeProviderAccounts(snapshot.reports, providerId) : []),
    [snapshot, providerId],
  );
  const [stored, setStored] = useState<{ supported: boolean; accounts: StoredAccount[] } | null>(null);
  const [version, setVersion] = useState(0);
  const [confirm, setConfirm] = useState<StoredAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch(`/api/auth/accounts/${encodeURIComponent(providerId)}`, { signal: controller.signal })
      .then((res) => res.json() as Promise<{ supported?: boolean; accounts?: StoredAccount[]; error?: string }>)
      // A failed listing degrades to the usage-based list rather than hiding accounts.
      .then((d) => {
        if (d.error) setError(d.error);
        setStored({ supported: d.supported === true, accounts: d.accounts ?? [] });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setStored({ supported: false, accounts: [] });
      });
    return () => controller.abort();
  }, [enabled, providerId, version]);

  const disconnect = async (account: StoredAccount) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(providerId)}?credentialId=${account.credentialId}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({})) as { error?: string; code?: string };
      if (!res.ok) throw new Error(d.error || d.code ? formatApiError(d) : `HTTP ${res.status}`);
      setConfirm(null);
      // Drop the row now; the refetch reconciles with omp's store.
      setStored((s) => s && { ...s, accounts: s.accounts.filter((a) => a.credentialId !== account.credentialId) });
      setVersion((v) => v + 1);
      onChanged();
    } catch (e) {
      setConfirm(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;
  const loading = stored === null || (!stored.supported && usageLoading);
  const rows = stored?.supported
    ? stored.accounts.map((a) => ({ key: String(a.credentialId), label: a.label, title: a.detail, plan: planForStoredAccount(a.label, stored.accounts.map((b) => b.label), usageAccounts), account: a }))
    : usageAccounts.map((u) => ({ key: u.key, label: u.label ?? t("modelsConfig.accountNumber", { index: u.index ?? 1 }), title: u.label, plan: u.plan, account: null }));
  if (!loading && rows.length === 0 && !error) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="provider-accounts">
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
        {rows.length > 1 ? t("modelsConfig.accountsCount", { count: rows.length }) : t("modelsConfig.accounts")}
      </div>
      {loading ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("modelsConfig.accountsLoading")}</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((row) => (
            <li
              key={row.key}
              style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--text)", padding: "4px 8px", background: "var(--bg-subtle)", borderRadius: "var(--radius-control)" }}
            >
              <span title={row.title} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
              {row.plan && <span style={{ color: "var(--text-dim)" }}>{row.plan}</span>}
              {row.account?.type === "api_key" && <span style={{ color: "var(--text-dim)" }}>{t("modelsConfig.accountApiKey")}</span>}
              {row.account && (
                <button
                  type="button"
                  onClick={() => setConfirm(row.account)}
                  disabled={busy}
                  aria-label={t("modelsConfig.disconnectAccount", { label: row.label })}
                  title={t("modelsConfig.disconnectAccount", { label: row.label })}
                  style={{ marginLeft: "auto", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: "none", border: "1px solid color-mix(in srgb, var(--status-error) 30%, transparent)", borderRadius: 5, color: "var(--status-error)", cursor: busy ? "not-allowed" : "pointer", fontSize: 11 }}
                >
                  <LogOut size={11} aria-hidden="true" /> {t("modelsConfig.disconnect")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p style={{ margin: 0, fontSize: 12, color: "var(--status-error)" }}>{error}</p>}
      {rows.length > 1 && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("modelsConfig.accountsRotationHint")}</p>
      )}
      {stored && !stored.supported && !error && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("errors.logout_unsupported")}</p>
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}
        title={t("modelsConfig.disconnectAccountTitle")}
        description={confirm ? t("modelsConfig.disconnectAccountBody", { label: confirm.label }) : undefined}
        confirmLabel={t("modelsConfig.disconnect")}
        cancelLabel={t("modelsConfig.cancel")}
        danger
        busy={busy}
        onConfirm={() => { if (confirm) void disconnect(confirm); }}
      />
    </div>
  );
}
