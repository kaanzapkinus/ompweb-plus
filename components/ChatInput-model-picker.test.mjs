import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ModelPickerPanel } = await jiti.import("./ChatInput-model-picker.tsx");
const { filterModelOptions, getCachedRecentModelKeys, setCachedRecentModelKeys } = await jiti.import("@/lib/model-picker");
const previousFetch = globalThis.fetch;
const options = [
  { provider: "alpha", modelId: "shared:model", name: "Shared model" },
  { provider: "beta", modelId: "shared:model", name: "Shared model" },
  { provider: "beta", modelId: "catalog-only", name: "Catalog model" },
];
const recentName = /Recent models|chatInput\.recentModels/;
const providersName = /Providers|chatInput\.providersLabel/;
const modelsName = /Models|chatInput\.modelsLabel/;

beforeEach(() => {
  setCachedRecentModelKeys(["alpha:shared:model"]);
  globalThis.fetch = async () => Response.json({ recentKeys: getCachedRecentModelKeys() });
});
afterEach(() => {
  cleanup();
  setCachedRecentModelKeys([]);
  globalThis.fetch = previousFetch;
});

function pickerProps(overrides = {}) {
  return {
    modelOptions: options,
    filteredModelOptions: options,
    currentModel: { provider: "beta", modelId: "shared:model" },
    modelSearchQuery: "",
    onSearchQueryChange() {},
    onSelectModel() {},
    ...overrides,
  };
}

  test("recent models are selectable before provider navigation", async () => {
    const selected = [];
    await act(async () => {
      render(React.createElement(ModelPickerPanel, pickerProps({
        onSelectModel: (...selection) => selected.push(selection),
      })));
    });
    assert.ok(screen.getByRole("group", { name: providersName }));
    const recent = screen.getByRole("group", { name: recentName });
    const row = within(recent).getByRole("menuitemradio", { name: /Shared model.*alpha/ });
    assert.equal(row.getAttribute("aria-checked"), "false", "same model ID under another provider is not active");
    fireEvent.click(row);
    assert.deepEqual(selected, [["alpha", "shared:model"]]);
    assert.equal(getCachedRecentModelKeys()[0], "alpha:shared:model");
  });

test("provider drilldown and back navigation retain one independent recent pane", async () => {
  await act(async () => {
    render(React.createElement(ModelPickerPanel, pickerProps()));
  });
  const recent = screen.getByRole("group", { name: recentName });
  fireEvent.click(within(screen.getByRole("group", { name: providersName })).getByRole("button", { name: /beta/ }));
  const catalog = screen.getByRole("group", { name: modelsName });
  assert.ok(within(catalog).getByRole("menuitemradio", { name: /Catalog model/ }));
  assert.equal(document.activeElement, within(catalog).getByRole("button", { name: providersName }));
  assert.equal(within(catalog).queryByRole("menuitemradio", { name: /Shared model.*alpha/ }), null);
  assert.equal(screen.getByRole("group", { name: recentName }), recent);
  assert.equal(screen.getAllByRole("group", { name: recentName }).length, 1);
  fireEvent.click(within(catalog).getByRole("button", { name: providersName }));
  assert.ok(screen.getByRole("group", { name: providersName }));
  assert.equal(document.activeElement, within(screen.getByRole("group", { name: providersName })).getByRole("button", { name: /beta/ }));
  assert.equal(screen.getByRole("group", { name: recentName }), recent);
});

test("full-catalog search does not filter or hide recent models and preserves exact selection", async () => {
  const selected = [];
  function SearchablePicker() {
    const [query, setQuery] = React.useState("");
    return React.createElement(ModelPickerPanel, pickerProps({
      modelSearchQuery: query,
      filteredModelOptions: filterModelOptions(options, query, "en"),
      onSearchQueryChange: setQuery,
      onSelectModel: (...selection) => selected.push(selection),
    }));
  }
  await act(async () => {
    render(React.createElement(SearchablePicker));
  });
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "catalog-only" } });
  const catalog = screen.getByRole("group", { name: modelsName });
  assert.ok(within(screen.getByRole("group", { name: recentName })).getByRole("menuitemradio", { name: /Shared model.*alpha/ }));
  fireEvent.click(within(catalog).getByRole("menuitemradio", { name: /Catalog model.*beta/ }));
  assert.deepEqual(selected, [["beta", "catalog-only"]]);
  assert.deepEqual(getCachedRecentModelKeys().slice(0, 2), ["beta:catalog-only", "alpha:shared:model"]);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  assert.ok(screen.getByRole("group", { name: providersName }));
});

test("server recent models hydrate the independent root pane", async () => {
  setCachedRecentModelKeys([]);
  globalThis.fetch = async () => Response.json({ recentKeys: ["beta:shared:model"] });
  await act(async () => { render(React.createElement(ModelPickerPanel, pickerProps())); });
  await waitFor(() => {
    const row = within(screen.getByRole("group", { name: recentName })).getByRole("menuitemradio", { name: /Shared model.*beta/ });
    assert.equal(row.getAttribute("aria-checked"), "true");
  });
  assert.ok(screen.getByRole("group", { name: providersName }));
});

test("orderProviderGroups respects preferredOrder and pins current provider", async () => {
  const { orderProviderGroups } = await jiti.import("./ChatInput-model-picker.tsx");
  const groups = [
    { provider: "tokenrouter", options: [] },
    { provider: "antigravity-tools", options: [] },
    { provider: "openrouter-ai", options: [] },
    { provider: "ollama", options: [] },
    { provider: "opencode", options: [] },
    { provider: "openai-codex", options: [] },
  ];
  const preferred = ["openai-codex", "antigravity-tools", "opencode", "openrouter-ai", "tokenrouter", "ollama"];
  const ordered = orderProviderGroups(groups, "openai-codex", preferred);
  assert.deepEqual(ordered.map((g) => g.provider), [
    "openai-codex",
    "antigravity-tools",
    "opencode",
    "openrouter-ai",
    "tokenrouter",
    "ollama",
  ]);
});
