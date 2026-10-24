"use client";

/**
 * Model selector: anchored dropdown on desktop, full-height keyboard-safe
 * sheet on compact layout. Owns open/query/focus state; ChatInput only
 * supplies options and receives the selection.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Clock, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useCompactLayout } from "@/hooks/useIsMobile";
import { Dialog } from "./ui/primitives";
import { SheetContent } from "./ui/primitives";
import {
  filterModelOptions,
  groupModelOptions,
  readStoredRecentModelKeys,
  storeRecentModelKey,
  fetchServerRecentModelKeys,
  subscribeRecentModelKeys,
  type ModelOption,
} from "@/lib/model-picker";

interface ModelPickerProps {
  options: ModelOption[];
  /** Currently active model; nullish ids never match an option. */
  active?: { provider: string; modelId: string } | null;
  /** True while streaming — the trigger renders disabled. */
  disabled?: boolean;
  /** Loading flag: options list still settling. */
  loading?: boolean;
  /** Upstream model error chip text, if any. */
  error?: string | null;
  /** Display name shown on the trigger (already resolved by the caller). */
  currentName?: string | null;
  /** True when the active selection is "auto" and re-picking it must re-apply. */
  isAutoSelection?: boolean;
  onSelect: (provider: string, modelId: string) => void;
}

export function ModelPicker({ options, active, disabled = false, loading = false, currentName, isAutoSelection = false, onSelect }: ModelPickerProps) {
  const { t, locale } = useI18n();
  const isCompact = useCompactLayout();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const desktopPanelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const triggerRectRef = useRef<{ top: number; left: number; width: number } | null>(null);
  const searchId = useId();

  const [recentKeys, setRecentKeys] = useState<string[]>(() => readStoredRecentModelKeys());

  useEffect(() => {
    void fetchServerRecentModelKeys().then((keys) => {
      if (keys.length > 0) setRecentKeys(keys);
    });
  }, [open]);

  useEffect(() => {
    return subscribeRecentModelKeys((keys) => {
      setRecentKeys(keys);
    });
  }, []);

  const recentOptions = useMemo(() => {
    const map = new Map<string, ModelOption>();
    for (const opt of options) {
      map.set(`${opt.provider}:${opt.modelId}`, opt);
    }
    return recentKeys
      .map((k) => map.get(k))
      .filter((opt): opt is ModelOption => opt !== undefined);
  }, [options, recentKeys]);

  const filteredRecent = useMemo(
    () => filterModelOptions(recentOptions, query, locale),
    [recentOptions, query, locale],
  );

  const filtered = useMemo(
    () => filterModelOptions(options, query, locale),
    [options, query, locale],
  );
  const groups = useMemo(() => groupModelOptions(filtered), [filtered]);
  // Reset the query when the picker closes; focus search on desktop open.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    if (!isCompact) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open, isCompact]);

  // Desktop only: close on outside click (the sheet has a backdrop instead).
  useEffect(() => {
    if (!open || isCompact) return;
    const handler = (e: MouseEvent) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        desktopPanelRef.current && !desktopPanelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, isCompact]);

  // Re-querying must never close the picker: only explicit close actions do.
  const select = (opt: ModelOption, isActive: boolean) => {
    const updated = storeRecentModelKey(opt.provider, opt.modelId);
    setRecentKeys(updated);
    if (!isActive || isAutoSelection) onSelect(opt.provider, opt.modelId);
    setOpen(false);
  };

  const activeOption = (opt: ModelOption) =>
    active != null && opt.modelId === active.modelId && opt.provider === active.provider;

  const listContent = (
    <>
      {filteredRecent.length === 0 && groups.length === 0 ? (
        <div style={{ padding: "9px 8px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
          {query.trim() ? t("chatInput.noMatchingModels") : loading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
        </div>
      ) : (
        <>
          {filteredRecent.length > 0 && (
            <div key="__recent__" className="omp-model-group" style={{ marginBottom: 4 }}>
              <div className="picker-group-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Clock size={11} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--accent)" }} />
                <span>{t("chatInput.recentModels") || "Recent"}</span>
              </div>
              {filteredRecent.map((opt) => {
                const isActive = activeOption(opt);
                return (
                  <button
                    className="picker-row"
                    data-active={isActive}
                    key={`recent:${opt.provider}:${opt.modelId}`}
                    onClick={() => select(opt, isActive)}
                  >
                    <span className="picker-check">
                      {isActive && <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>}
                    </span>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{opt.name}</span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", paddingLeft: 8, flexShrink: 0 }}>{opt.provider}</span>
                  </button>
                );
              })}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.provider} className="omp-model-group">
              <div className="picker-group-label">{group.provider}</div>
              {group.options.map((opt) => {
                const isActive = activeOption(opt);
                return (
                  <button
                    className="picker-row"
                    data-active={isActive}
                    key={`${opt.provider}:${opt.modelId}`}
                    onClick={() => select(opt, isActive)}
                  >
                    <span className="picker-check">
                      {isActive && <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>}
                    </span>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{opt.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </>
      )}
    </>
  );

  const searchField = (
    <label className="picker-search" htmlFor={searchId}>
      <Search size={13} strokeWidth={1.8} color="var(--text-dim)" aria-hidden="true" />
      <input
        id={searchId}
        ref={searchInputRef}
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        // 16px: below this iOS Safari auto-zooms and breaks panel geometry.
        style={{ fontSize: 16 }}
        placeholder={t("chatInput.searchModels")}
        aria-label={t("chatInput.searchModels")}
      />
    </label>
  );

  const headerIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)" }}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
    </svg>
  );

  return (
    <>
      <button
        ref={triggerRef}
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          triggerRectRef.current = { top: rect.top, left: rect.left, width: rect.width };
          setOpen((v) => !v);
        }}
        disabled={disabled}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          height: 28,
          maxWidth: 190,
          padding: "0 8px",
          overflow: "hidden",
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 7,
          color: "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12,
          opacity: disabled ? 0.5 : 1,
          transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
        }}
        onMouseEnter={(e) => {
          if (disabled) return;
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
        title={options.length > 0
          ? t("chatInput.changeModel")
          : loading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {headerIcon}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {currentName ?? (options.length > 0
            ? t("chatInput.selectModel")
            : loading ? t("chatInput.loadingModels") : t("chatInput.noModels"))}
        </span>
        <ChevronDown size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true" />
      </button>

      {isCompact ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <SheetContent variant="full" ariaLabel={t("chatInput.modelsLabel")}>
            <div className="omp-sheet-header">
              {headerIcon}
              <span className="omp-sheet-title">{t("chatInput.modelsLabel")}</span>
              <span className="picker-panel-count">{options.length}</span>
            </div>
            <div style={{ padding: "8px 8px 6px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
              {searchField}
            </div>
            <div className="omp-sheet-body picker-list">
              {listContent}
            </div>
          </SheetContent>
        </Dialog>
      ) : open && triggerRectRef.current && (() => {
        const rect = triggerRectRef.current;
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const bottom = viewportHeight - rect.top + 6;
        const maxH = Math.max(120, Math.min(rect.top - 8, viewportHeight * 0.6));
        return (
          <div ref={desktopPanelRef} className="picker-panel" style={{
            position: "fixed",
            bottom,
            left: rect.left,
            width: "max-content",
            minWidth: rect.width,
            maxWidth: "calc(100vw - 16px)",
            zIndex: 500,
            display: "flex", flexDirection: "column",
            maxHeight: maxH,
          }}>
            <div className="picker-panel-header">
              {headerIcon}
              <span className="picker-panel-title">{t("chatInput.modelsLabel")}</span>
              <span className="picker-panel-count">{options.length}</span>
            </div>
            <div style={{ paddingRight: 8, paddingLeft: 8 }}>
              {searchField}
            </div>
            <div className="picker-list">
              {listContent}
            </div>
          </div>
        );
      })()}
    </>
  );
}
