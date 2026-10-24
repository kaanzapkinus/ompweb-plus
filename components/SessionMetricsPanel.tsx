"use client";

/**
 * Compact session telemetry: an always-visible strip atop the chat
 * plus a detail sheet. Values come exclusively from lib/session-metrics —
 * unknown data renders as "—", never a fabricated 0 or percent.
 */
import { useState } from "react";
import { Activity, Gauge, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import { Dialog, SheetContent } from "./ui/primitives";
import type { SessionMetrics } from "@/lib/session-metrics";

function speedLabel(value: number | null): string {
  return value !== null ? `${value.toFixed(1)} t/s` : "—";
}

function tokenLabel(value: number | null): string {
  return value !== null ? formatCompactNumber(value, "en") : "—";
}

function countLabel(value: number | null): string {
  return value !== null ? value.toLocaleString("en") : "—";
}

interface SessionMetricsPanelProps {
  metrics: SessionMetrics | null;
}

export function SessionMetricsPanel({ metrics }: SessionMetricsPanelProps) {
  const { t } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);
  if (!metrics?.hasAny) return null;

  const ctxColor = metrics.contextLevel === "error"
    ? "var(--status-error)"
    : metrics.contextLevel === "warning"
      ? "var(--status-warning)"
      : "var(--text-muted)";

  const ctxWindow = tokenLabel(metrics.contextWindow);
  const ctxShort = `${tokenLabel(metrics.contextTokens)} / ${ctxWindow}`;
  const costLabel = metrics.cost !== null ? `$${metrics.cost.toFixed(2)}` : "—";
  const cacheRate = metrics.cacheHitRate !== null ? formatPercent(metrics.cacheHitRate) : "—";

  return (
    <>
      <button
        type="button"
        className="omp-metrics-strip ui-focus-ring"
        onClick={() => setSheetOpen(true)}
        aria-label={t("appShell.sessionInfo")}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        data-compact-level={metrics.contextLevel ?? "none"}
        style={{
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
          minHeight: 40,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 14,
          rowGap: 6,
          padding: "8px 12px",
          background: "var(--bg-panel)",
          border: "none",
          borderBottom: "1px solid var(--border)",
          color: "var(--text-muted)",
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.5,
          textAlign: "left",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }} title={metrics.currentSpeed !== null ? "Live generation speed" : "Session average generation speed"}>
          <Activity size={11} strokeWidth={2} aria-hidden="true" />
          {metrics.currentSpeed !== null
            ? speedLabel(metrics.currentSpeed)
            : metrics.averageSpeed !== null
              ? `AVG ${speedLabel(metrics.averageSpeed)}`
              : "— t/s"}
        </span>
        <span style={{ color: "var(--text)", whiteSpace: "nowrap" }} title="Cumulative chat cost in USD. API-valued estimate, not necessarily your invoice.">
          {costLabel}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", color: ctxColor }} title="Current context tokens / model context window">
          <Gauge size={11} strokeWidth={2} aria-hidden="true" />
          {ctxShort}
        </span>
      </button>

      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent variant="full" ariaLabel={t("appShell.sessionInfo")}>
          <div className="omp-sheet-header">
            <span className="omp-sheet-title">{t("appShell.sessionInfo")}</span>
            <button
              type="button"
              onClick={() => setSheetOpen(false)}
              aria-label={t("chatWindow.close")}
              className="shell-toolbar-btn ui-focus-ring"
              style={{ marginLeft: "auto" }}
            >
              <X size={16} />
            </button>
          </div>
          <div className="omp-sheet-body" style={{ padding: "12px 16px", display: "grid", gap: 14, fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <section style={{ display: "grid", gap: 6 }}>
              <SectionTitle>Performance</SectionTitle>
              <MetricRow label="Current" value={speedLabel(metrics.currentSpeed)} />
              <MetricRow label="Average" value={metrics.averageSpeed !== null ? `AVG ${speedLabel(metrics.averageSpeed)}` : "—"} />
              {metrics.maxOutputTokens !== null && (
                <MetricRow label="Max output" value={formatCompactNumber(metrics.maxOutputTokens, "en")} />
              )}
            </section>

            <section style={{ display: "grid", gap: 6 }}>
              <SectionTitle>Context</SectionTitle>
              <MetricRow label="Used" value={metrics.contextTokens !== null ? formatCompactNumber(metrics.contextTokens, "en") : "—"} color={ctxColor} />
              <MetricRow label="Window" value={ctxWindow} />
              <MetricRow label="Percent" value={metrics.contextPercent !== null ? formatPercent(metrics.contextPercent) : "—"} color={ctxColor} />
            </section>

            <section style={{ display: "grid", gap: 6 }}>
              <SectionTitle>{t("appShell.sectionTokens")}</SectionTitle>
              <MetricRow label={t("appShell.statInput")} value={countLabel(metrics.inputTokens)} />
              <MetricRow label={t("appShell.statOutput")} value={countLabel(metrics.outputTokens)} />
              <MetricRow label={t("appShell.statCacheRead")} value={countLabel(metrics.cacheRead)} />
              <MetricRow label={t("appShell.statCacheWrite")} value={countLabel(metrics.cacheWrite)} />
              <MetricRow label={t("appShell.statCacheRate")} value={cacheRate} />
              <MetricRow label="Processed total" value={countLabel(metrics.processedTotal)} />
              <MetricRow label={`${t("appShell.statCost")} (USD)`} value={costLabel} />
              <p style={{ margin: "2px 0 0", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                Cumulative chat cost is an API-valued estimate, not necessarily your invoice.
              </p>
            </section>

            <section style={{ display: "grid", gap: 6 }}>
              <SectionTitle>{t("appShell.sectionMessages")}</SectionTitle>
              <MetricRow label={t("appShell.statUser")} value={countLabel(metrics.userMessages)} />
              <MetricRow label={t("appShell.statAssistant")} value={countLabel(metrics.assistantMessages)} />
              <MetricRow label={t("appShell.statToolCalls")} value={countLabel(metrics.toolCalls)} />
              <MetricRow label={t("appShell.statTotal")} value={countLabel(metrics.totalMessages)} />
            </section>

            <section style={{ display: "grid", gap: 6 }}>
              <SectionTitle>{t("appShell.sectionSessionInfo")}</SectionTitle>
              {metrics.sessionId && <MetricRow label="ID" value={metrics.sessionId} />}
            </section>
          </div>
        </SheetContent>
      </Dialog>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>{children}</div>;
}

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, minHeight: 28, alignItems: "center" }}>
      <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ color: color ?? "var(--text)", fontVariantNumeric: "tabular-nums", textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}
