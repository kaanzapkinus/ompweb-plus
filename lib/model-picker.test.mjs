import assert from "node:assert/strict";
import test from "node:test";

import { filterModelOptions, groupModelOptions, parseRecentModelKeys, pushRecentModelKey } from "./model-picker.ts";

const options = [
  { provider: "OpenAI", modelId: "gpt-5.2", name: "GPT-5.2" },
  { provider: "Anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "ollama", modelId: "qwen3:8b", name: "qwen3:8b" },
  { provider: "OpenAI", modelId: "gpt-5.2-mini", name: "GPT-5.2 mini" },
];

test("filters by display name, identifier, and provider", () => {
  assert.deepEqual(filterModelOptions(options, "sonnet", "en"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "5.2", "en"), [options[0], options[3]]);
  assert.deepEqual(filterModelOptions(options, "openai", "en"), [options[0], options[3]]);
  assert.deepEqual(filterModelOptions(options, "qwen3", "en"), [options[2]]);
});

test("search is case-insensitive and trims the query", () => {
  assert.deepEqual(filterModelOptions(options, "  CLAUDE  ", "en"), [options[1]]);
});

test("empty query returns the same array reference", () => {
  assert.equal(filterModelOptions(options, "   ", "en"), options);
});

test("no match returns empty array", () => {
  assert.deepEqual(filterModelOptions(options, "zzz-none", "en"), []);
});

test("groups preserve first-seen provider order and intra-group order", () => {
  const groups = groupModelOptions(options);
  assert.deepEqual(groups.map((g) => g.provider), ["OpenAI", "Anthropic", "ollama"]);
  assert.deepEqual(groups[0].options, [options[0], options[3]]);
});

test("duplicate display names are preserved, not deduplicated", () => {
  const dupes = [
    { provider: "a", modelId: "m1", name: "Same" },
    { provider: "b", modelId: "m2", name: "Same" },
  ];
  assert.deepEqual(filterModelOptions(dupes, "same", "en"), dupes);
  const groups = groupModelOptions(dupes);
  assert.equal(groups.length, 2);
});

test("grouping an empty list yields no groups", () => {
  assert.deepEqual(groupModelOptions([]), []);
});

test("parseRecentModelKeys parses valid provider:modelId keys", () => {
  assert.deepEqual(parseRecentModelKeys('["google:gemini", "ollama:qwen3:8b"]'), ["google:gemini", "ollama:qwen3:8b"]);
  assert.deepEqual(parseRecentModelKeys(null), []);
  assert.deepEqual(parseRecentModelKeys("invalid-json"), []);
  assert.deepEqual(parseRecentModelKeys('["invalid-key", 123, "google:model"]'), ["google:model"]);
});

test("pushRecentModelKey adds key to front and deduplicates", () => {
  const initial = ["google:gemini", "ollama:qwen"];
  const updated = pushRecentModelKey(initial, "anthropic:claude");
  assert.deepEqual(updated, ["anthropic:claude", "google:gemini", "ollama:qwen"]);

  // Re-selecting an existing moves it to front
  const reselected = pushRecentModelKey(updated, "google:gemini");
  assert.deepEqual(reselected, ["google:gemini", "anthropic:claude", "ollama:qwen"]);
});

test("pushRecentModelKey respects max limit", () => {
  const list = ["m1:1", "m2:2", "m3:3"];
  const clamped = pushRecentModelKey(list, "m4:4", 3);
  assert.deepEqual(clamped, ["m4:4", "m1:1", "m2:2"]);
});
