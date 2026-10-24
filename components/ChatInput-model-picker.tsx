"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { fetchServerRecentModelKeys, readStoredRecentModelKeys, storeRecentModelKey } from "@/lib/model-picker";
import { providerInitials } from "./ModelsConfig-types";
import type { ModelOption } from "./ChatInput-model-options";

export interface ProviderModelGroup {
  provider: string;
  options: ModelOption[];
}

export function groupModelOptionsByProvider(options: ModelOption[]): ProviderModelGroup[] {
  const groups: ProviderModelGroup[] = [];
  const byProvider = new Map<string, ProviderModelGroup>();
  for (const option of options) {
    let group = byProvider.get(option.provider);
    if (!group) {
      group = { provider: option.provider, options: [] };
      byProvider.set(option.provider, group);
      groups.push(group);
    }
    group.options.push(option);
  }
  return groups;
}

/** Orders provider groups by preferredOrder (if provided) and pins currentProvider to top. */
export function orderProviderGroups(
  groups: ProviderModelGroup[],
  currentProvider: string | null | undefined,
  preferredOrder?: readonly string[],
): ProviderModelGroup[] {
  let ordered = groups;
  if (preferredOrder && preferredOrder.length > 0) {
    const rank = new Map(preferredOrder.map((id, index) => [id, index]));
    ordered = [...groups].sort((a, b) => {
      const rankA = rank.has(a.provider) ? rank.get(a.provider)! : Number.MAX_SAFE_INTEGER;
      const rankB = rank.has(b.provider) ? rank.get(b.provider)! : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return a.provider.localeCompare(b.provider);
    });
  }
  if (!currentProvider) return ordered;
  const index = ordered.findIndex((g) => g.provider === currentProvider);
  if (index <= 0) return ordered;
  const next = [...ordered];
  const [active] = next.splice(index, 1);
  next.unshift(active);
  return next;
}

export function ProviderBadge({ id, size = 16 }: { id: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {providerInitials(id)}
    </span>
  );
}

export interface ModelPickerPanelProps {
  /** All visible options (already filtered by composer-picker visibility). */
  modelOptions: ModelOption[];
  /** Options matching the current search query. */
  filteredModelOptions: ModelOption[];
  currentModel?: { provider: string; modelId: string } | null;
  modelSearchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  showModelsLoading?: boolean;
  onSelectModel: (provider: string, modelId: string) => void;
  onOpenProviders?: () => void;
  onClose?: () => void;
  providerOrder?: readonly string[];
}

/**
 * Provider/catalog drilldown on the left, with independent recent models on
 * the right at every viewport size. Search spans the full catalog.
 */
export function ModelPickerPanel({
  modelOptions,
  filteredModelOptions,
  currentModel,
  modelSearchQuery,
  onSearchQueryChange,
  searchInputRef,
  showModelsLoading,
  onSelectModel,
  onOpenProviders,
  onClose,
  providerOrder,
}: ModelPickerPanelProps) {
  const { t } = useI18n();
  const searching = modelSearchQuery.trim().length > 0;
  const groups = useMemo(
    () => orderProviderGroups(groupModelOptionsByProvider(modelOptions), currentModel?.provider, providerOrder),
    [modelOptions, currentModel?.provider, providerOrder],
  );
  const filteredGroups = useMemo(
    () => orderProviderGroups(groupModelOptionsByProvider(filteredModelOptions), currentModel?.provider, providerOrder),
    [filteredModelOptions, currentModel?.provider, providerOrder],
  );

  // Keep catalog navigation separate from both current selection and recents.
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const activeGroup = groups.find((group) => group.provider === selectedProvider);
  const catalogId = useId();
  const browsingCatalog = searching || Boolean(activeGroup);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const providerButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const lastProviderRef = useRef<string | null>(null);
  const moveCatalogFocusRef = useRef(false);
  useEffect(() => {
    if (!moveCatalogFocusRef.current) return;
    moveCatalogFocusRef.current = false;
    const target = selectedProvider === null
      ? providerButtonsRef.current.get(lastProviderRef.current ?? "")
      : backButtonRef.current;
    target?.focus();
  }, [selectedProvider]);

  const [recentKeys, setRecentKeys] = useState<string[]>(() => readStoredRecentModelKeys());
  useEffect(() => {
    void fetchServerRecentModelKeys().then((keys) => { if (keys.length > 0) setRecentKeys(keys); });
  }, []);
  const recentOptions = useMemo(() => {
    const byKey = new Map(modelOptions.map((option) => [`${option.provider}:${option.modelId}`, option]));
    return recentKeys.map((key) => byKey.get(key)).filter((option): option is ModelOption => option !== undefined);
  }, [modelOptions, recentKeys]);

  const selectModel = (opt: ModelOption) => {
    setRecentKeys(storeRecentModelKey(opt.provider, opt.modelId));
    onSelectModel(opt.provider, opt.modelId);
  };

  const renderModelRow = (opt: ModelOption, opts?: { showProvider?: boolean }) => {
    const isActive = Boolean(currentModel)
      && opt.modelId === currentModel?.modelId
      && opt.provider === currentModel?.provider;
    return (
      <button
        className="picker-row"
        data-active={isActive}
        aria-label={`${opt.name || opt.modelId} (${opt.provider}/${opt.modelId})`}
        type="button"
        key={`${opt.provider}:${opt.modelId}`}
        role="menuitemradio"
        aria-checked={isActive}
        onClick={() => selectModel(opt)}
      >
        <span className="picker-check">{isActive && <Check size={11} strokeWidth={2.4} aria-hidden="true" />}</span>
        <span className="picker-model-copy">
          <span className="picker-model-name" title={opt.modelId}>{opt.name || opt.modelId}</span>
          {opts?.showProvider && <span className="picker-model-provider">{opt.provider}</span>}
        </span>
      </button>
    );
  };

  return (
    <>
      <label className="picker-search">
        <Search size={13} strokeWidth={1.8} color="var(--text-dim)" aria-hidden="true" />
        <input
          ref={searchInputRef}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={modelSearchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose?.();
            }
          }}
          placeholder={t("chatInput.searchModels")}
          aria-label={t("chatInput.searchModels")}
        />
      </label>

      <div className="picker-nested">
        <div className="picker-catalog">
          {browsingCatalog ? (
            <div id={catalogId} className="picker-catalog-pane" role="group" aria-label={t("chatInput.modelsLabel")}>
              {searching ? (
                <div className="picker-pane-heading">{t("chatInput.modelsLabel")}</div>
              ) : (
                <button
                  ref={backButtonRef}
                  type="button"
                  className="picker-pane-heading picker-catalog-back"
                  onClick={() => { moveCatalogFocusRef.current = true; setSelectedProvider(null); }}
                >
                  <ChevronLeft size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span>{t("chatInput.providersLabel")}</span>
                </button>
              )}
              <div className="picker-nested-models">
                {searching ? (
                  filteredGroups.length > 0 ? filteredGroups.map((group) => (
                    <div key={group.provider}>
                      <div className="picker-group-label">{group.provider}</div>
                      {group.options.map((opt) => renderModelRow(opt, { showProvider: true }))}
                    </div>
                  )) : (
                    <div className="picker-empty">
                      {showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noMatchingModels")}
                    </div>
                  )
                ) : (
                  <>
                    <div className="picker-group-label">{activeGroup?.provider}</div>
                    {activeGroup?.options.map((opt) => renderModelRow(opt))}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div id={catalogId} className="picker-catalog-pane" role="group" aria-label={t("chatInput.providersLabel")}>
              <div className="picker-pane-heading">{t("chatInput.providersLabel")}</div>
              <div className="picker-nested-providers">
                {groups.length === 0 ? (
                  <div className="picker-empty">
                    {showModelsLoading ? t("chatInput.loadingModels") : t("chatInput.noAvailableModels")}
                  </div>
                ) : groups.map((group) => {
                  const isCurrent = currentModel?.provider === group.provider;
                  return (
                    <button
                      key={group.provider}
                      ref={(node) => { if (node) providerButtonsRef.current.set(group.provider, node); else providerButtonsRef.current.delete(group.provider); }}
                      type="button"
                      className="picker-row picker-provider-row"
                      data-current={isCurrent}
                      onClick={() => { lastProviderRef.current = group.provider; moveCatalogFocusRef.current = true; setSelectedProvider(group.provider); }}
                      aria-current={isCurrent ? "true" : undefined}
                      aria-controls={catalogId}
                    >
                      <ProviderBadge id={group.provider} size={15} />
                      <span className="picker-provider-name">{group.provider}</span>
                      <ChevronRight size={12} strokeWidth={1.8} style={{ marginLeft: "auto", flexShrink: 0, opacity: 0.55 }} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="picker-recent-models" role="group" aria-label={t("chatInput.recentModels")}>
          <div className="picker-pane-heading">{t("chatInput.recentModels")}</div>
          <div className="picker-recent-list">
            {recentOptions.length > 0 ? recentOptions.map((opt) => renderModelRow(opt, { showProvider: true })) : (
              <div className="picker-empty">{t("chatInput.selectModel")}</div>
            )}
          </div>
        </div>
      </div>

      {onOpenProviders && (
        <button
          type="button"
          className="picker-row picker-add-providers"
          onClick={() => {
            onOpenProviders();
          }}
        >
          <Plus size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>{t("chatInput.addProviders")}</span>
        </button>
      )}
    </>
  );
}
