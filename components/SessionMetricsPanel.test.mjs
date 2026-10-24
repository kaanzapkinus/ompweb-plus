import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionMetricsPanel } = await jiti.import("./SessionMetricsPanel.tsx");
const { buildSessionMetrics } = await jiti.import("../lib/session-metrics.ts");
afterEach(cleanup);

const stats = {
  sessionId: "chat-metrics",
  userMessages: 2,
  assistantMessages: 3,
  toolCalls: 1,
  toolResults: 1,
  totalMessages: 6,
  tokens: { input: 2000, output: 500, cacheRead: 8000, cacheWrite: 0, total: 10500 },
  cost: 0,
};

function metrics(overrides = {}) {
  return buildSessionMetrics({
    stats,
    contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
    modelCapacity: null,
    liveTokensPerSecond: null,
    averageTokensPerSecond: 42,
    ...overrides,
  });
}

test("chat cost rounds to cents without changing the measured amount", () => {
  const measured = metrics({ stats: { ...stats, cost: 1.239 } });
  render(React.createElement(SessionMetricsPanel, { metrics: measured }));
  within(screen.getByRole("button", { name: "Session info" })).getByText("$1.24", { exact: true });
  assert.equal(measured.cost, 1.239);
});

test("the chat strip switches from live token speed to its idle average", () => {
  const view = render(React.createElement(SessionMetricsPanel, { metrics: metrics({ liveTokensPerSecond: 61.2 }) }));
  const strip = within(screen.getByRole("button", { name: "Session info" }));
  strip.getByText("61.2 t/s", { exact: true });
  assert.equal(strip.queryByText("AVG 42.0 t/s", { exact: true }), null);
  view.rerender(React.createElement(SessionMetricsPanel, { metrics: metrics() }));
  strip.getByText("AVG 42.0 t/s", { exact: true });
  assert.equal(strip.queryByText("61.2 t/s", { exact: true }), null);
});

test("model-only telemetry shows unknown amounts, not measured zero", () => {
  render(React.createElement(SessionMetricsPanel, {
    metrics: metrics({ stats: null, contextUsage: null, modelCapacity: { contextWindow: 200000 }, averageTokensPerSecond: null }),
  }));
  const strip = screen.getByRole("button", { name: "Session info" });
  assert.match(strip.textContent, /— \/ 200k/);
  assert.doesNotMatch(strip.textContent, /\$0|0\.0%/);
});

test("opening metrics details retains zero values and explains API-valued cost", async () => {
  const user = userEvent.setup();
  render(React.createElement(SessionMetricsPanel, { metrics: metrics() }));
  await user.click(screen.getByRole("button", { name: "Session info" }));
  const sheet = screen.getByRole("dialog", { name: "Session info" });
  within(sheet).getByText("$0.00", { exact: true });
  assert.match(sheet.textContent, /80\.0%/);
  assert.match(sheet.textContent, /API-valued estimate.*invoice/i);
  await user.click(within(sheet).getByRole("button", { name: "Close" }));
  assert.equal(screen.queryByRole("dialog"), null);
});
