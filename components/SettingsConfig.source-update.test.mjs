import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SettingsConfig } = await jiti.import("./SettingsConfig.tsx");
const { checkNpmUpdate } = await jiti.import("../lib/npm-update.ts");
const originalFetch = globalThis.fetch;

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async () => Response.json({});
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.matchMedia;
  globalThis.fetch = originalFetch;
});

test("source installs expose manual update instructions without a registry release", async () => {
  const appUpdate = await checkNpmUpdate();
  assert.equal(appUpdate.updateAvailable, false);
  await act(async () => {
  render(React.createElement(SettingsConfig, {
    activeTab: "system",
    cwd: null,
    sessionId: null,
    toolCallsDefaultCollapsed: false,
    hideToolActivity: false,
    expandThinkingByDefault: false,
    providerUsageVisible: true,
    scopeNativeSelectAll: false,
    openUrlAutomatically: false,
    appUpdate,
    ompUpdatesDisabled: true,
    onToolCallsDefaultCollapsedChange() {},
    onHideToolActivityChange() {},
    onExpandThinkingByDefaultChange() {},
    onProviderUsageVisibleChange() {},
    onScopeNativeSelectAllChange() {},
    onOpenUrlAutomaticallyChange() {},
    onModelsSaved() {},
    onPluginsReloaded() {},
    onRefreshAppUpdate: async () => appUpdate,
    onOmpUpdateAvailabilityChange() {},
    onRequestAppUpdate() { assert.fail("source web updates must not invoke an installer"); },
    onSelectTab() {},
    onClose() {},
    }));
  });
  assert.equal(screen.getByText(appUpdate.updateCommand, { selector: "code" }).textContent, appUpdate.updateCommand);
});
