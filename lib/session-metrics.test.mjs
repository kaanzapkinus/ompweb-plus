import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildSessionMetrics } = await jiti.import("./session-metrics.ts");

const baseStats = {
  sessionId: "s1",
  userMessages: 2,
  assistantMessages: 5,
  toolCalls: 7,
  toolResults: 7,
  totalMessages: 14,
  tokens: { input: 1000, output: 200, cacheRead: 8000, cacheWrite: 50, total: 9250 },
  cost: 0.25,
};

test("splits real tokens from cached token totals", () => {
  const m = buildSessionMetrics({ stats: baseStats, contextUsage: null, modelCapacity: null, liveTokensPerSecond: null, averageTokensPerSecond: null });
  assert.equal(m.realTokens, 1200);
  assert.equal(m.processedTotal, 9250);
  assert.equal(m.inputTokens, 1000);
  assert.equal(m.outputTokens, 200);
  assert.equal(m.cost, 0.25);
  assert.equal(m.hasAny, true);
});

test("live speed shows only while positive; average separately", () => {
  const live = buildSessionMetrics({ stats: null, contextUsage: null, modelCapacity: null, liveTokensPerSecond: 42.1, averageTokensPerSecond: 50 });
  assert.equal(live.currentSpeed, 42.1);
  assert.equal(live.averageSpeed, 50);

  const idle = buildSessionMetrics({ stats: null, contextUsage: null, modelCapacity: null, liveTokensPerSecond: null, averageTokensPerSecond: 50 });
  assert.equal(idle.currentSpeed, null);
  assert.equal(idle.averageSpeed, 50);

  const zero = buildSessionMetrics({ stats: null, contextUsage: null, modelCapacity: null, liveTokensPerSecond: 0, averageTokensPerSecond: 0 });
  assert.equal(zero.currentSpeed, null);
  assert.equal(zero.averageSpeed, null);
});

test("negative or non-finite speed values are rejected", () => {
  const m = buildSessionMetrics({ stats: null, contextUsage: null, modelCapacity: null, liveTokensPerSecond: -5, averageTokensPerSecond: NaN });
  assert.equal(m.currentSpeed, null);
  assert.equal(m.averageSpeed, null);
});

test("context prefers live usage window over model capacity", () => {
  const m = buildSessionMetrics({
    stats: baseStats,
    contextUsage: { percent: 13.2, contextWindow: 1000000, tokens: 132000 },
    modelCapacity: { contextWindow: 200000, maxTokens: 65536 },
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.contextWindow, 1000000);
  assert.equal(m.contextTokens, 132000);
  assert.equal(m.contextPercent, 13.2);
  assert.equal(m.contextLevel, "ok");
  assert.equal(m.maxOutputTokens, 65536);
});

test("context falls back to model capacity window without live usage", () => {
  const m = buildSessionMetrics({
    stats: baseStats,
    contextUsage: null,
    modelCapacity: { contextWindow: 200000, maxTokens: 65536 },
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.contextWindow, 200000);
  assert.equal(m.contextTokens, null);
  assert.equal(m.contextPercent, null);
  assert.equal(m.contextLevel, null);
});

test("unknown context never fabricates zero or percent", () => {
  const m = buildSessionMetrics({ stats: baseStats, contextUsage: null, modelCapacity: null, liveTokensPerSecond: null, averageTokensPerSecond: null });
  assert.equal(m.contextWindow, null);
  assert.equal(m.contextTokens, null);
  assert.equal(m.contextPercent, null);
});

test("context thresholds: warning at 70+, error at 90+", () => {
  const mk = (percent) => buildSessionMetrics({
    stats: baseStats,
    contextUsage: { percent, contextWindow: 1000000, tokens: null },
    modelCapacity: null,
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(mk(69.9).contextLevel, "ok");
  assert.equal(mk(70).contextLevel, "warning");
  assert.equal(mk(89.9).contextLevel, "warning");
  assert.equal(mk(90).contextLevel, "error");
});

test("cumulative session input is never presented as context used", () => {
  const m = buildSessionMetrics({
    stats: baseStats,
    contextUsage: { percent: null, contextWindow: 1000000, tokens: null },
    modelCapacity: null,
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.contextTokens, null);
  assert.equal(m.contextPercent, null);
});


test("computes context percent from valid context tokens and window when percent is null", () => {
  const m = buildSessionMetrics({
    stats: baseStats,
    contextUsage: { percent: null, contextWindow: 200000, tokens: 50000 },
    modelCapacity: null,
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.contextTokens, 50000);
  assert.equal(m.contextWindow, 200000);
  assert.equal(m.contextPercent, 25);
  assert.equal(m.contextLevel, "ok");
});
test("empty state reports nothing available", () => {
  const m = buildSessionMetrics({ stats: null, contextUsage: null, modelCapacity: null, liveTokensPerSecond: null, averageTokensPerSecond: null });
  assert.equal(m.hasAny, false);
  assert.equal(m.sessionId, null);
});

test("missing telemetry stays unknown even when model context capacity is available", () => {
  const m = buildSessionMetrics({
    stats: null,
    contextUsage: null,
    modelCapacity: { contextWindow: 200000 },
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.hasAny, true);
  for (const field of ["inputTokens", "outputTokens", "cacheRead", "cacheWrite", "realTokens", "processedTotal", "cost", "cacheHitRate", "userMessages"]) {
    assert.equal(m[field], null, field);
  }
});

test("reported zero cost and cache usage remain measured zero, without inventing a hit rate", () => {
  const m = buildSessionMetrics({
    stats: { ...baseStats, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    contextUsage: null,
    modelCapacity: null,
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.cost, 0);
  assert.equal(m.cacheRead, 0);
  assert.equal(m.cacheWrite, 0);
  assert.equal(m.processedTotal, 0);
  assert.equal(m.cacheHitRate, null);
});

test("cache hit percentage uses cumulative branch input and cache reads, not output or writes", () => {
  const m = buildSessionMetrics({
    stats: { ...baseStats, tokens: { input: 2000, output: 200, cacheRead: 8000, cacheWrite: 1000, total: 11200 } },
    contextUsage: null,
    modelCapacity: null,
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.cacheHitRate, 80);
  assert.equal(m.processedTotal, 11200);
});

test("invalid or absent telemetry cannot turn into a zero measurement or partial total", () => {
  const m = buildSessionMetrics({
    stats: { ...baseStats, cost: undefined, tokens: { ...baseStats.tokens, input: NaN, cacheWrite: undefined } },
    contextUsage: null,
    modelCapacity: null,
    liveTokensPerSecond: null,
    averageTokensPerSecond: null,
  });
  assert.equal(m.inputTokens, null);
  assert.equal(m.cacheWrite, null);
  assert.equal(m.cost, null);
  assert.equal(m.realTokens, null);
  assert.equal(m.processedTotal, null);
  assert.equal(m.cacheHitRate, null);
  assert.equal(m.cacheRead, 8000);
});
