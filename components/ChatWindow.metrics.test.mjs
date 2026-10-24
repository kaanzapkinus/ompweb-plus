import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useGenerationSpeed } = await jiti.import("./ChatWindow.tsx");
const { SessionMetricsPanel } = await jiti.import("./SessionMetricsPanel.tsx");
const { buildSessionMetrics } = await jiti.import("../lib/session-metrics.ts");
const messages = [];

function MetricsHarness({ tokensPerSecond, agentRunning }) {
  const speed = useGenerationSpeed({ tokensPerSecond, agentRunning, sessionBusy: agentRunning, messages, sessionKey: "chat-1" });
  return React.createElement(SessionMetricsPanel, { metrics: buildSessionMetrics({
    stats: null, contextUsage: null, modelCapacity: null,
    liveTokensPerSecond: speed?.current ?? null,
    averageTokensPerSecond: speed?.average ?? null,
  }) });
}

afterEach(cleanup);

for (const finalSample of [40, 60]) {
  test(`metrics details clear live speed after stopping with a final ${finalSample} TPS sample`, async () => {
    let view;
    await act(async () => { view = render(React.createElement(MetricsHarness, { tokensPerSecond: 40, agentRunning: true })); });
    fireEvent.click(screen.getByRole("button", { name: "Session info" }));
    await act(async () => { view.rerender(React.createElement(MetricsHarness, { tokensPerSecond: 40, agentRunning: false })); });
    await act(async () => { view.rerender(React.createElement(MetricsHarness, { tokensPerSecond: finalSample, agentRunning: false })); });
    const sheet = screen.getByRole("dialog");
    const current = within(sheet).getByText("Current").parentElement;
    assert.equal(current.textContent, "Current—");
    assert.match(within(sheet).getByText("Average").parentElement.textContent, finalSample === 60 ? /AVG 50\.0 t\/s/ : /AVG 40\.0 t\/s/);
  });
}
