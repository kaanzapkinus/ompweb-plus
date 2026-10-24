/**
 * Pure session-metrics view model: one honest source of truth for the compact
 * telemetry strip and the metrics sheet. No React, no DOM.
 */
import type { SessionStatsInfo } from "./pi-types";
import { getCacheHitRate } from "./format";

export interface ContextUsageShape {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ModelCapacityShape {
  contextWindow?: number;
  maxTokens?: number;
}

export interface SessionMetricsInput {
  stats: SessionStatsInfo | null;
  contextUsage: ContextUsageShape | null;
  modelCapacity: ModelCapacityShape | null;
  /** Live omp tokensPerSecond; positive and finite only. */
  liveTokensPerSecond: number | null;
  /** Rolling session average (samples from this session only). */
  averageTokensPerSecond: number | null;
}

export interface SessionMetrics {
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** cacheRead / (input + cacheRead), matching omp stats; unknown with no denominator. */
  cacheHitRate: number | null;
  /** input + output (prompt + completion; cache excluded). */
  realTokens: number | null;
  /** input + output + cacheRead + cacheWrite, as omp reports it. */
  processedTotal: number | null;
  /** Cumulative API-valued estimate, not necessarily an invoiced charge. */
  cost: number | null;
  userMessages: number | null;
  assistantMessages: number | null;
  toolCalls: number | null;
  totalMessages: number | null;
  /** Live speed, null when OMP is not currently generating. */
  currentSpeed: number | null;
  /** Session-scoped rolling average, null with no valid samples yet. */
  averageSpeed: number | null;
  /** Context tokens used, only from omp-reported data. */
  contextTokens: number | null;
  /** Context window: live usage window first, else selected model capacity. */
  contextWindow: number | null;
  /** Context percent 0–100 from omp, null when unknown. */
  contextPercent: number | null;
  /** "ok" | "warning" (≥70) | "error" (≥90); null when percent unknown. */
  contextLevel: "ok" | "warning" | "error" | null;
  maxOutputTokens: number | null;
  hasAny: boolean;
}

function finiteNonNegative(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function measured(value: number | undefined | null): number | null {
  return finiteNonNegative(value) ? value : null;
}

export function buildSessionMetrics(input: SessionMetricsInput): SessionMetrics {
  const { stats, contextUsage, modelCapacity, liveTokensPerSecond, averageTokensPerSecond } = input;

  const inputTokens = measured(stats?.tokens.input);
  const outputTokens = measured(stats?.tokens.output);
  const cacheRead = measured(stats?.tokens.cacheRead);
  const cacheWrite = measured(stats?.tokens.cacheWrite);
  const realTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const processedTotal = realTokens !== null && cacheRead !== null && cacheWrite !== null ? realTokens + cacheRead + cacheWrite : null;
  const cacheHitRate = inputTokens !== null && cacheRead !== null ? getCacheHitRate(inputTokens, cacheRead) : null;

  const currentSpeed =
    typeof liveTokensPerSecond === "number" && Number.isFinite(liveTokensPerSecond) && liveTokensPerSecond > 0
      ? liveTokensPerSecond
      : null;
  const averageSpeed =
    typeof averageTokensPerSecond === "number" && Number.isFinite(averageTokensPerSecond) && averageTokensPerSecond > 0
      ? averageTokensPerSecond
      : null;

  const liveTokens: number | null = contextUsage && finiteNonNegative(contextUsage.tokens ?? null) ? (contextUsage.tokens ?? null) : null;
  const liveWindow: number | null = contextUsage && typeof contextUsage.contextWindow === "number" && finiteNonNegative(contextUsage.contextWindow) && contextUsage.contextWindow > 0 ? contextUsage.contextWindow : null;
  const livePercent = contextUsage && typeof contextUsage.percent === "number" && Number.isFinite(contextUsage.percent)
    ? contextUsage.percent
    : null;
  const capacityWindow: number | null = modelCapacity && typeof modelCapacity.contextWindow === "number" && finiteNonNegative(modelCapacity.contextWindow) && modelCapacity.contextWindow > 0 ? modelCapacity.contextWindow : null;

  const contextWindow: number | null = liveWindow !== null ? liveWindow : (capacityWindow !== null ? capacityWindow : null);
  const contextTokens: number | null = liveTokens;
  const contextPercent: number | null = livePercent !== null
    ? livePercent
    : (contextTokens !== null && contextWindow !== null && contextWindow > 0 ? Math.round((contextTokens / contextWindow) * 1000) / 10 : null);
  const contextLevel = contextPercent === null
    ? null
    : contextPercent >= 90 ? "error" : contextPercent >= 70 ? "warning" : "ok";

  const maxOutputTokens: number | null = modelCapacity && finiteNonNegative(modelCapacity.maxTokens ?? null) ? (modelCapacity.maxTokens ?? null) : null;

  const hasAny = Boolean(
    stats
    || currentSpeed !== null
    || averageSpeed !== null
    || contextWindow !== null
    || maxOutputTokens !== null,
  );

  return {
    sessionId: stats?.sessionId ?? null,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    cacheHitRate,
    realTokens,
    processedTotal,
    cost: measured(stats?.cost),
    userMessages: measured(stats?.userMessages),
    assistantMessages: measured(stats?.assistantMessages),
    toolCalls: measured(stats?.toolCalls),
    totalMessages: measured(stats?.totalMessages),
    currentSpeed,
    averageSpeed,
    contextTokens,
    contextWindow,
    contextPercent,
    contextLevel,
    maxOutputTokens,
    hasAny,
  };
}
