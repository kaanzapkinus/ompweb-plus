import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionExecutionControls } = await jiti.import("./SessionExecutionControls.tsx");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { useGlobalKeyboardShortcuts } = await jiti.import("../hooks/useKeyboardShortcuts.ts");

let fixtureSequence = 0;
let fixtureSessionId = "";
let draftRecords = new Map();
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
function draftResponse(url, init = {}) {
  const parsed = new URL(url, "http://fixture.test");
  if (parsed.pathname !== "/api/drafts") return null;
  const body = init.body ? JSON.parse(init.body) : null;
  const key = body?.key ?? parsed.searchParams.get("key");
  const current = draftRecords.get(key) ?? { key, revision: 0, updatedAt: "2026-10-29T00:00:00Z", payload: null };
  if (init.method === "PUT") {
    if (body.baseRevision !== current.revision) return Response.json({ record: current }, { status: 409 });
    const record = { ...current, revision: current.revision + 1, payload: body.payload };
    draftRecords.set(key, record);
    return Response.json({ record });
  }
  return Response.json({ record: current });
}
function ScheduleComposer(props) {
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [available, setAvailable] = React.useState(false);
  const [policyContainer, setPolicyContainer] = React.useState(null);
  const returnFocus = React.useRef(null);
  useGlobalKeyboardShortcuts({ activeCwd: props.newSessionCwd, onNewSession: props.onNewSession });
  return React.createElement(React.Fragment, null,
    React.createElement(SessionExecutionControls, {
      ...props, scheduleOpen, onScheduleOpenChange: setScheduleOpen,
      newSessionWorkspaceId: props.newSessionWorkspaceId ?? `fixture-${fixtureSequence}`,
      onScheduleAvailabilityChange: setAvailable,
      scheduleReturnFocus: () => returnFocus.current,
      policyContainer,
    }),
    React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, isStreaming: props.streaming ?? false,
      draftKey: `normal-fixture-${fixtureSequence}`,
      onSchedulePrompt: (trigger) => { returnFocus.current = trigger; setScheduleOpen(true); },
      scheduleDisabled: !available,
      onExecutionPolicyContainerChange: setPolicyContainer,
    }),
  );
}
const previousFetch = globalThis.fetch;
const previousScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
let endpoint = "";
const currentModel = Object.freeze({ provider: "alpha", modelId: "shared:model" });
const models = [
  { provider: "alpha", id: "shared:model", name: "Shared model" },
  { provider: "beta", id: "shared:model", name: "Shared model" },
  { provider: "beta", id: "other", name: "Other model" },
];

beforeEach(() => {
  fixtureSessionId = `fixture-chat-${++fixtureSequence}`;
  endpoint = `/api/sessions/${fixtureSessionId}/execution`;
  draftRecords = new Map();
  let handler = previousFetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    get: () => {
      const current = handler;
      return (url, init) => draftResponse(url, init) ?? current(url, init);
    },
    set: value => { handler = value; },
  });
  window.localStorage.clear();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

async function cleanupComposer() {
  // Dialog unmount queues focus cleanup; settle it while browser globals still exist.
  await act(async () => { cleanup(); });
}

afterEach(async () => {
  await cleanupComposer();
  Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
  if (previousScrollIntoView) window.HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
  else delete window.HTMLElement.prototype.scrollIntoView;
  delete window.matchMedia;
});

async function mount({ jobs = [], usage = { generatedAt: null, reports: [] }, usageError = false, onUsage, onMutation, ...overrides } = {}) {
  let snapshot = { policy: { mode: "fallback" }, jobs };
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });
    if (String(url).startsWith("/api/provider-usage")) {
      return onUsage ? onUsage() : usageError ? Response.json({ error: "Usage unavailable" }, { status: 503 }) : Response.json(usage);
    }
    assert.equal(url, endpoint, "scheduling must not fetch another catalog or send a chat command");
    if (method === "GET") return Response.json(snapshot);
    const response = await onMutation?.({ method, body, snapshot });
    if (response instanceof Response) return response;
    if (response) snapshot = response;
    return Response.json(snapshot);
  };
  const props = { sessionId: fixtureSessionId, currentModel, models, ...overrides };
  let view;
  await act(async () => { view = render(React.createElement(ScheduleComposer, props)); });
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "More actions" }).disabled, false));
  return {
    requests,
    async rerender(changes) {
      Object.assign(props, changes);
      await act(async () => { view.rerender(React.createElement(ScheduleComposer, props)); });
    },
  };
}

async function openSchedule(user) {
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await waitFor(() => assert.equal(screen.getByRole("menuitem", { name: "Schedule prompt" }).disabled, false));
  await user.click(screen.getByRole("menuitem", { name: "Schedule prompt" }));
  return screen.getByRole("dialog", { name: "Schedule prompt" });
}

function modelOption(dialog, name) {
  return within(dialog).getByRole("option", { name });
}

test("composer policy choices persist through menu closure and update the per-chat execution policy", async () => {
  const user = userEvent.setup();
  const { requests } = await mount({
    onMutation({ body, snapshot }) { return { ...snapshot, policy: { mode: body.mode } }; },
  });
  await user.click(screen.getByRole("button", { name: "More actions" }));
  const wait = await screen.findByRole("menuitemradio", { name: "Keep model, wait for quota" });
  await waitFor(() => assert.equal(wait.disabled, false));
  assert.equal(screen.getByRole("menuitemradio", { name: "Allow fallback" }).getAttribute("aria-checked"), "true");
  await user.click(wait);
  await waitFor(() => assert.equal(wait.getAttribute("aria-checked"), "true"));
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "More actions" }));
  assert.equal(screen.getByRole("menuitemradio", { name: "Keep model, wait for quota" }).getAttribute("aria-checked"), "true");
  await user.click(screen.getByRole("menuitemradio", { name: "Allow fallback" }));
  await waitFor(() => assert.equal(screen.getByRole("menuitemradio", { name: "Allow fallback" }).getAttribute("aria-checked"), "true"));
  assert.deepEqual(requests.filter(({ method }) => method === "PUT").map(({ url, body }) => ({ url, body })), [
    { url: endpoint, body: { mode: "wait" } },
    { url: endpoint, body: { mode: "fallback" } },
  ]);
});

test("a rejected policy update retains the saved choice and can be retried after reopening the menu", async () => {
  const user = userEvent.setup();
  let attempts = 0;
  await mount({
    onMutation({ body, snapshot }) {
      if (++attempts === 1) return Response.json({ error: "Policy unavailable" }, { status: 503 });
      return { ...snapshot, policy: { mode: body.mode } };
    },
  });
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await waitFor(() => assert.equal(screen.getByRole("menuitemradio", { name: "Keep model, wait for quota" }).disabled, false));
  await user.click(screen.getByRole("menuitemradio", { name: "Keep model, wait for quota" }));
  await waitFor(() => assert.match(screen.getByRole("alert").textContent, /Policy unavailable/));
  assert.equal(screen.getByRole("menuitemradio", { name: "Allow fallback" }).getAttribute("aria-checked"), "true");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Keep model, wait for quota" }));
  await waitFor(() => assert.equal(screen.getByRole("menuitemradio", { name: "Keep model, wait for quota" }).getAttribute("aria-checked"), "true"));
  assert.equal(screen.queryByRole("alert"), null);
});

test("a provider-qualified dialog choice is scheduled without changing the active composer model", async () => {
  const user = userEvent.setup();
  const { requests } = await mount();
  const dialog = await openSchedule(user);
  const select = within(dialog).getByRole("combobox", { name: "Model" });
  assert.equal(modelOption(dialog, "Shared model — alpha / shared:model").selected, true);
  await user.selectOptions(select, modelOption(dialog, "Shared model — beta / shared:model"));
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Run the report later");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  const writes = requests.filter(({ method }) => method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "POST");
  assert.equal(writes[0].url, endpoint);
  assert.equal(writes[0].body.provider, "beta");
  assert.equal(writes[0].body.modelId, "shared:model");
  assert.equal(writes[0].body.prompt, "Run the report later");
  assert.ok(writes[0].body.runAt > Date.now());
  assert.match(writes[0].body.requestId, /^[a-f0-9]{32}$/);
  assert.deepEqual(currentModel, { provider: "alpha", modelId: "shared:model" });
});

test("an absent current model never silently chooses the first available model", async () => {
  const user = userEvent.setup();
  const { requests } = await mount({ currentModel: null });
  const dialog = await openSchedule(user);
  const select = within(dialog).getByRole("combobox", { name: "Model" });
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Run later");
  assert.equal(select.value, "");
  const submit = within(dialog).getByRole("button", { name: "Schedule", exact: true });
  assert.equal(submit.disabled, true);
  await user.selectOptions(select, modelOption(dialog, "Other model — beta / other"));
  assert.equal(submit.disabled, false);
  await user.click(submit);
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(requests.find(({ method }) => method === "POST").body.modelId, "other");
});

test("missing selections stay explicit and block submission, including when a model disappears", async () => {
  const user = userEvent.setup();
  const { requests, rerender } = await mount({ currentModel: { provider: "missing", modelId: "retired" } });
  const dialog = await openSchedule(user);
  const select = within(dialog).getByRole("combobox", { name: "Model" });
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Run later");
  assert.equal(modelOption(dialog, /missing \/ retired.*unavailable/i).selected, true);
  const submit = within(dialog).getByRole("button", { name: "Schedule", exact: true });
  assert.equal(submit.disabled, true);
  fireEvent.submit(submit.closest("form"));
  await waitFor(() => assert.ok(within(dialog).getByRole("alert")));
  assert.equal(requests.filter(({ method }) => method === "POST").length, 0);
  await user.selectOptions(select, modelOption(dialog, "Other model — beta / other"));
  assert.equal(submit.disabled, false);
  await rerender({ models: models.filter(({ id }) => id !== "other") });
  assert.equal(modelOption(dialog, /beta \/ other.*unavailable/i).selected, true);
  assert.equal(submit.disabled, true);
  fireEvent.submit(submit.closest("form"));
  assert.equal(requests.filter(({ method }) => method === "POST").length, 0);
});

test("loading an empty catalog keeps the current selection until it becomes available", async () => {
  const user = userEvent.setup();
  const { rerender } = await mount({ models: [], modelsLoading: true });
  const dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Run later");
  assert.equal(modelOption(dialog, /alpha \/ shared:model.*unavailable/i).selected, true);
  assert.ok(within(dialog).getByText("Loading models…"));
  const submit = within(dialog).getByRole("button", { name: "Schedule", exact: true });
  assert.equal(submit.disabled, true);
  await rerender({ models, modelsLoading: false });
  assert.equal(modelOption(dialog, "Shared model — alpha / shared:model").selected, true);
  assert.equal(submit.disabled, false);
});

test("an open model choice survives composer changes and reopening", async () => {
  const user = userEvent.setup();
  const { rerender } = await mount();
  let dialog = await openSchedule(user);
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), modelOption(dialog, "Other model — beta / other"));
  await rerender({ currentModel: { provider: "beta", modelId: "shared:model" } });
  assert.equal(modelOption(dialog, "Other model — beta / other").selected, true);
  const form = within(dialog).getByRole("textbox", { name: "Prompt" }).closest("form");
  await user.click(within(form).getByRole("button", { name: "Close", exact: true }));
  dialog = await openSchedule(user);
  assert.equal(modelOption(dialog, "Other model — beta / other").selected, true);
});

test("a failed request keeps its prompt and model and retries the identical deduplicated request", async () => {
  const user = userEvent.setup();
  let attempts = 0;
  const { requests, rerender } = await mount({
    onMutation() {
      if (++attempts === 1) return Response.json({ error: "Temporarily offline" }, { status: 503 });
    },
  });
  const dialog = await openSchedule(user);
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), modelOption(dialog, "Other model — beta / other"));
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "  Keep this draft  ");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.match(within(dialog).getByRole("alert").textContent, /Temporarily offline/));
  await rerender({ currentModel: { provider: "beta", modelId: "shared:model" } });
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "  Keep this draft  ");
  assert.equal(modelOption(dialog, "Other model — beta / other").selected, true);
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  const posts = requests.filter(({ method }) => method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, posts[0].body, "retry keeps the same requestId, runAt, prompt and chosen model");
  assert.equal(posts[0].body.prompt, "Keep this draft");
  assert.equal(posts[0].body.provider, "beta");
  assert.equal(posts[0].body.modelId, "other");
});

test("manual quota resume keeps its pinned model readonly while cancellation remains usable", async () => {
  const user = userEvent.setup();
  const waiting = { id: "quota-1", kind: "resume", status: "waiting", runAt: null, prompt: "", createdAt: 1, provider: "saved", modelId: "pinned" };
  const completed = { id: "old-1", kind: "prompt", status: "completed", runAt: 1, prompt: "Old scheduled prompt", createdAt: 1, provider: "alpha", modelId: "shared:model" };
  const { requests } = await mount({
    jobs: [waiting, completed],
    onMutation({ method, body, snapshot }) {
      if (method === "PUT") return { ...snapshot, jobs: snapshot.jobs.map((job) => job.id === body.jobId ? { ...job, runAt: body.resumeAt } : job) };
      if (method === "DELETE") return { ...snapshot, jobs: snapshot.jobs.map((job) => job.id === body.jobId ? { ...job, status: "cancelled" } : job) };
    },
  });
  assert.equal(screen.queryByText("Old scheduled prompt"), null);
  await user.click(screen.getByRole("button", { name: /Scheduled prompts/ }));
  await user.click(screen.getByRole("button", { name: "Set resume time" }));
  const dialog = screen.getByRole("dialog", { name: "Set resume time" });
  assert.equal(within(dialog).queryByRole("combobox", { name: "Model" }), null);
  assert.match(within(dialog).getByText(/Saved model:/).textContent, /saved \/ pinned/);
  fireEvent.change(within(dialog).getByLabelText("Local date and time"), { target: { value: "2099-01-02T12:00" } });
  await user.click(within(dialog).getByRole("button", { name: "Set resume time", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  const update = requests.find(({ method }) => method === "PUT");
  assert.deepEqual(update.body, { jobId: "quota-1", resumeAt: new Date("2099-01-02T12:00").getTime() });
  await user.click(screen.getByRole("button", { name: /Scheduled prompts/ }));
  await user.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Cancel", exact: true }), null));
  assert.deepEqual(requests.find(({ method }) => method === "DELETE").body, { jobId: "quota-1" });
  assert.equal(requests.some(({ method }) => method === "POST"), false);
});

test("scheduling remains usable without newer mobile AbortSignal helpers", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "timeout", { ...descriptor, value: undefined });
  try {
    const user = userEvent.setup();
    const { requests } = await mount();
    const dialog = await openSchedule(user);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), modelOption(dialog, "Other model — beta / other"));
    await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Run on mobile");
    await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    assert.equal(requests.find(({ method }) => method === "POST").body.modelId, "other");
  } finally {
    Object.defineProperty(AbortSignal, "timeout", descriptor);
  }
});

test("90 minutes normalizes on blur and submits a valid 1h 30m delay without an arbitrary cap", async () => {
  const user = userEvent.setup();
  const { requests } = await mount();
  const dialog = await openSchedule(user);
  const hours = within(dialog).getByRole("spinbutton", { name: "Hours" });
  const minutes = within(dialog).getByRole("spinbutton", { name: "Minutes" });
  fireEvent.change(hours, { target: { value: "0" } });
  fireEvent.change(minutes, { target: { value: "90" } });
  assert.equal(minutes.validity.valid, true);
  fireEvent.blur(minutes);
  assert.equal(hours.value, "1");
  assert.equal(minutes.value, "30");
  assert.ok(within(dialog).getByText("1h 30m"));
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "After ninety minutes");
  const before = Date.now();
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  const runAt = requests.find(({ method }) => method === "POST").body.runAt;
  assert.ok(runAt >= before + 5_400_000 && runAt <= Date.now() + 5_400_000);
});

test("provider renewal uses the exact reported reset and only exact model or provider-wide scopes", async () => {
  const user = userEvent.setup();
  const resetAt = Date.now() + 7_234_567;
  const { requests } = await mount({ usage: {
    generatedAt: Date.now() - 300_000,
    reports: [
      { provider: "alpha", modelId: "shared:model", accountLabel: "one@example.com", fiveHour: { percent: 100, resetsAt: resetAt, resetMinutes: 121 }, sevenDay: { percent: 90, resetsAt: resetAt + 9_000_000 } },
      { provider: "alpha", accountLabel: "one@example.com", monthly: { percent: 50, resetsAt: resetAt + 20_000_000 } },
      { provider: "alpha", modelId: "SHARED:MODEL", fiveHour: { percent: 100, resetsAt: resetAt + 1000 } },
      { provider: "alpha", modelId: "unrelated", fiveHour: { percent: 100, resetsAt: resetAt + 2000 } },
      { provider: "beta", modelId: "shared:model", fiveHour: { percent: 100, resetsAt: resetAt + 3000 } },
    ],
  } });
  const dialog = await openSchedule(user);
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  const reset = await within(dialog).findByRole("combobox", { name: "Reported reset" });
  const options = within(reset).getAllByRole("option").filter((option) => option.value);
  assert.equal(options.length, 3);
  assert.ok(options.every((option) => option.textContent.includes("one@example.com")));
  assert.ok(options.some((option) => option.textContent.includes("Provider-wide")));
  assert.equal(reset.value, "", "multiple windows must be an explicit choice");
  await user.selectOptions(reset, options[0]);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "At the actual reset");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  const body = requests.find(({ method }) => method === "POST").body;
  assert.equal(body.runAt, resetAt, "do not round reset time or add cache age to now");
  assert.equal(body.provider, "alpha");
  assert.equal(body.modelId, "shared:model");
  assert.equal(Object.hasOwn(body, "accountLabel"), false);
});

test("missing and stale provider reset data never invent a reset and keep manual timing available", async () => {
  const user = userEvent.setup();
  const { requests } = await mount({ usage: { generatedAt: Date.now(), reports: [
    { provider: "alpha", modelId: "shared:model", fiveHour: { percent: 100, resetMinutes: 30 }, sevenDay: { percent: 100, resetsAt: Date.now() - 1000 } },
  ] } });
  const dialog = await openSchedule(user);
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  await within(dialog).findByText(/No future reset time reported/);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Manual time instead");
  assert.equal(within(dialog).getByRole("button", { name: "Schedule", exact: true }).disabled, true);
  await user.click(within(dialog).getByRole("button", { name: "At a specific time" }));
  fireEvent.change(within(dialog).getByLabelText("Local date and time"), { target: { value: "2099-01-02T12:00" } });
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(requests.find(({ method }) => method === "POST").body.runAt, new Date("2099-01-02T12:00").getTime());
});

test("saved resume quota choices use the pinned model rather than the current composer", async () => {
  const user = userEvent.setup();
  const resetAt = Date.now() + 7_234_567;
  const waiting = { id: "quota-1", kind: "resume", status: "waiting", runAt: null, prompt: "", createdAt: 1, provider: "saved", modelId: "pinned" };
  const { requests } = await mount({ jobs: [waiting], usage: { generatedAt: Date.now(), reports: [
    { provider: "saved", modelId: "pinned", fiveHour: { percent: 100, resetsAt: resetAt } },
    { provider: "alpha", modelId: "shared:model", fiveHour: { percent: 100, resetsAt: resetAt + 1000 } },
  ] } });
  await user.click(screen.getByRole("button", { name: /Scheduled prompts/ }));
  await user.click(screen.getByRole("button", { name: "Set resume time" }));
  const dialog = screen.getByRole("dialog", { name: "Set resume time" });
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  const reset = await within(dialog).findByRole("combobox", { name: "Reported reset" });
  await user.selectOptions(reset, within(reset).getAllByRole("option").find((option) => option.value));
  await user.click(within(dialog).getByRole("button", { name: "Set resume time", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.deepEqual(requests.find(({ method }) => method === "PUT").body, { jobId: "quota-1", resumeAt: resetAt });
  assert.ok(requests.some(({ url }) => url === "/api/provider-usage?provider=saved&refresh=true"));
});

test("provider usage failures are distinct from missing resets and can be retried", async () => {
  const user = userEvent.setup();
  await mount({ usageError: true });
  const dialog = await openSchedule(user);
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  await within(dialog).findByText("Provider reset data could not be loaded.");
  assert.equal(within(dialog).queryByText(/No future reset time reported/), null);
  assert.equal(within(dialog).getByRole("button", { name: "Schedule", exact: true }).disabled, true);
  globalThis.fetch = async (url) => {
    assert.equal(url, "/api/provider-usage?provider=alpha&refresh=true");
    return Response.json({ generatedAt: Date.now(), reports: [
      { provider: "alpha", fiveHour: { percent: 100, resetsAt: Date.now() + 3_600_000 } },
    ] });
  };
  await user.click(within(dialog).getByRole("button", { name: "Refresh", exact: true }));
  assert.ok(await within(dialog).findByRole("combobox", { name: "Reported reset" }));
});

test("changing the dialog model clears an inapplicable reset rather than guessing a model match", async () => {
  const user = userEvent.setup();
  const { requests } = await mount({ usage: { generatedAt: Date.now(), reports: [
    { provider: "alpha", modelId: "shared:model", fiveHour: { percent: 100, resetsAt: Date.now() + 3_600_000 } },
  ] } });
  const dialog = await openSchedule(user);
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  const reset = await within(dialog).findByRole("combobox", { name: "Reported reset" });
  await user.selectOptions(reset, within(reset).getAllByRole("option").find((option) => option.value));
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Different provider");
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), modelOption(dialog, "Shared model — beta / shared:model"));
  await within(dialog).findByText(/No future reset time reported/);
  assert.equal(within(dialog).getByRole("button", { name: "Schedule", exact: true }).disabled, true);
  assert.equal(requests.some(({ method }) => method === "POST"), false);
});

test("changing models requires a fresh choice even for a shared provider-wide reset", async () => {
  const user = userEvent.setup();
  await mount({ models: [...models, { provider: "alpha", id: "second", name: "Second" }], usage: { generatedAt: Date.now(), reports: [
    { provider: "alpha", fiveHour: { percent: 100, resetsAt: Date.now() + 3_600_000 } },
  ] } });
  const dialog = await openSchedule(user);
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  const reset = await within(dialog).findByRole("combobox", { name: "Reported reset" });
  await user.selectOptions(reset, within(reset).getAllByRole("option").find((option) => option.value));
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Choose another model");
  const submit = within(dialog).getByRole("button", { name: "Schedule", exact: true });
  assert.equal(submit.disabled, false);
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), modelOption(dialog, "Second — alpha / second"));
  assert.equal(reset.value, "");
  assert.equal(submit.disabled, true);
});

test("a reset that expires while the dialog is open cannot create a new scheduled job", async (t) => {
  const user = userEvent.setup();
  const resetAt = Date.now() + 3_600_000;
  const { requests } = await mount({ usage: { generatedAt: Date.now(), reports: [
    { provider: "alpha", fiveHour: { percent: 100, resetsAt: resetAt } },
  ] } });
  const dialog = await openSchedule(user);
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  const reset = await within(dialog).findByRole("combobox", { name: "Reported reset" });
  await user.selectOptions(reset, within(reset).getAllByRole("option").find((option) => option.value));
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Too late");
  t.mock.method(Date, "now", () => resetAt + 1);
  fireEvent.submit(within(dialog).getByRole("textbox", { name: "Prompt" }).closest("form"));
  assert.ok(within(dialog).getByRole("alert"));
  assert.equal(requests.some(({ method }) => method === "POST"), false);
});

test("delays beyond the removed 720-hour browser cap reach the server unchanged", async () => {
  const user = userEvent.setup();
  const { requests } = await mount();
  const dialog = await openSchedule(user);
  const hours = within(dialog).getByRole("spinbutton", { name: "Hours" });
  fireEvent.change(hours, { target: { value: "900" } });
  assert.equal(hours.validity.valid, true);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Long delay");
  const before = Date.now();
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  const runAt = requests.find(({ method }) => method === "POST").body.runAt;
  assert.ok(runAt >= before + 3_240_000_000 && runAt <= Date.now() + 3_240_000_000);
});

test("new chat scheduling posts to the dedicated schedule endpoint and promotes the created conversation", async () => {
  const user = userEvent.setup();
  let promotedSession = null;
  const created = { id: "created-1", cwd: "/tmp/workspace", path: "/tmp/workspace/session.jsonl", created: "2026-10-23T12:00:00.000Z", modified: "2026-10-23T12:00:00.000Z", messageCount: 0, firstMessage: "(no messages)" };
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });
    if (method === "POST" && url === "/api/sessions/schedule") {
      return Response.json({ policy: { mode: "fallback" }, jobs: [{ id: "job-1", prompt: body.prompt, runAt: body.runAt, provider: body.provider, modelId: body.modelId, status: "pending" }], session: created });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  await act(async () => {
    render(React.createElement(ScheduleComposer, {
      sessionId: undefined,
      newSessionCwd: "/tmp/workspace",
      newSessionWorkspaceId: "companion",
      onSessionCreated: (s) => { promotedSession = s; },
      currentModel,
      models,
    }));
  });
  const dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Run later from new chat");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(promotedSession?.id, "created-1");
  const post = requests.find(({ method }) => method === "POST");
  assert.equal(post.url, "/api/sessions/schedule");
  assert.equal(post.body.cwd, "/tmp/workspace");
  assert.equal(post.body.workspaceId, "companion");
  assert.equal(post.body.prompt, "Run later from new chat");
  assert.equal(post.body.provider, "alpha");
  assert.equal(post.body.modelId, "shared:model");
});

test("scheduling from a busy composer's menu closes the menu and returns focus to its persistent plus trigger", async () => {
  const user = userEvent.setup();
  await mount({ streaming: true });
  assert.equal(screen.queryByRole("button", { name: /^Schedule prompt/ }), null);
  const plus = screen.getByRole("button", { name: "More actions" });
  plus.focus();
  await user.keyboard("{ArrowDown}");
  const menu = await screen.findByRole("menu", { name: "More actions" });
  await waitFor(() => assert.ok(document.activeElement === within(menu).getAllByRole("menuitem")[0], "ArrowDown moves focus into the menu"));
  await user.keyboard("{End}");
  assert.ok(document.activeElement === within(menu).getByRole("menuitem", { name: "Schedule prompt" }), "End focuses Schedule");
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Schedule prompt" });
  assert.equal(screen.queryByRole("menu"), null);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Keep this draft");
  const form = within(dialog).getByRole("textbox", { name: "Prompt" }).closest("form");
  await user.click(within(form).getByRole("button", { name: "Close", exact: true }));
  await waitFor(() => assert.ok(document.activeElement === plus, "closing Schedule returns focus to plus"));
});

test("a pending schedule survives menu dismissal and Escape without losing its in-flight request", async () => {
  const user = userEvent.setup();
  let release;
  const result = new Promise((resolve) => { release = resolve; });
  const { requests } = await mount({ onMutation: () => result });
  const dialog = await openSchedule(user);
  assert.equal(screen.queryByRole("menu"), null);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Only once");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  try {
    assert.equal(within(dialog).getByRole("button", { name: "Saving…" }).disabled, true);
    await user.keyboard("{Escape}");
    assert.ok(screen.getByRole("dialog", { name: "Schedule prompt" }) === dialog, "Escape cannot dismiss a pending schedule");
    assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Only once");
    assert.equal(requests.filter(({ method }) => method === "POST").length, 1);
  } finally {
    await act(async () => { release(); await result; });
  }
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
});

test("Escape dismisses the composer menu to plus without opening a schedule", async () => {
  const user = userEvent.setup();
  const { requests } = await mount();
  const plus = screen.getByRole("button", { name: "More actions" });
  plus.focus();
  await user.keyboard("{ArrowUp}");
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("menuitem", { name: "Schedule prompt" }), "ArrowUp opens the menu at its last item"));
  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("menu"), null);
  assert.equal(screen.queryByRole("dialog"), null);
  assert.ok(document.activeElement === plus, "Escape returns menu focus to plus");
  assert.equal(requests.some(({ method }) => method === "POST"), false);
});

for (const refreshOutcome of ["removed", "next-window", "error"]) {
  test(`an uncertain quota POST retries its exact body after reset expiry and ${refreshOutcome} refresh`, async (t) => {
    const user = userEvent.setup();
    const resetAt = Date.now() + 3_600_000;
    let refresh = false;
    let attempts = 0;
    const { requests } = await mount({
      onUsage: () => refresh
        ? refreshOutcome === "error"
          ? Response.json({ error: "Usage unavailable" }, { status: 503 })
          : Response.json({ generatedAt: Date.now(), reports: refreshOutcome === "removed" ? [] : [
            { provider: "alpha", fiveHour: { percent: 0, resetsAt: resetAt + 3_600_000 } },
          ] })
        : Response.json({ generatedAt: Date.now(), reports: [
          { provider: "alpha", fiveHour: { percent: 100, resetsAt: resetAt } },
        ] }),
      onMutation: () => { if (++attempts === 1) throw new Error("Response lost"); },
    });
    const dialog = await openSchedule(user);
    await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
    const reset = await within(dialog).findByRole("combobox", { name: "Reported reset" });
    await user.selectOptions(reset, within(reset).getAllByRole("option").find((option) => option.value));
    const prompt = within(dialog).getByRole("textbox", { name: "Prompt" });
    await user.type(prompt, "Reconcile this request");
    const submit = within(dialog).getByRole("button", { name: "Schedule", exact: true });
    await user.click(submit);
    await waitFor(() => assert.match(within(dialog).getByRole("alert").textContent, /Response lost/));
    t.mock.method(Date, "now", () => resetAt + 1);
    refresh = true;
    await user.click(within(dialog).getByRole("button", { name: "Refresh", exact: true }));
    await waitFor(() => assert.equal(within(dialog).queryByText("Loading provider resets…"), null));
    assert.equal(submit.disabled, false, "reset eligibility must not block reconciliation");
    fireEvent.change(prompt, { target: { value: "A different request" } });
    assert.equal(submit.disabled, true, "a changed intent cannot reuse the expired reset");
    fireEvent.submit(prompt.closest("form"));
    assert.equal(requests.filter(({ method }) => method === "POST").length, 1);
    fireEvent.change(prompt, { target: { value: "Reconcile this request" } });
    assert.equal(submit.disabled, false, "returning to the unchanged intent restores its original request");
    await user.click(submit);
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    const posts = requests.filter(({ method }) => method === "POST");
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, posts[0].body);
  });
}

test("the global new-chat shortcut cannot navigate behind a pending scheduling dialog", async () => {
  const user = userEvent.setup();
  let navigations = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  await mount({ newSessionCwd: "/tmp/workspace", onNewSession: () => { navigations++; }, onMutation: () => response });
  const dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Keep this pending");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  try {
    fireEvent.keyDown(within(dialog).getByRole("textbox", { name: "Prompt" }), { key: "n", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, altKey: true });
    assert.equal(navigations, 0);
    assert.ok(screen.getByRole("dialog") === dialog);
  } finally {
    await act(async () => { release(); await response; });
  }
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  fireEvent.keyDown(window, { key: "n", ctrlKey: true, altKey: true });
  assert.equal(navigations, 1, "the shortcut remains available after the modal closes");
});

test("an old new-chat POST cannot promote its session after navigation unmounts the composer", async () => {
  const user = userEvent.setup();
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const created = { id: "scheduled-chat", cwd: "/tmp/workspace", messageCount: 0 };
  let selected = "new-chat";
  let savedJob = null;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("/api/provider-usage")) return Response.json({ generatedAt: null, reports: [] });
    if (String(url).startsWith("/api/stt?")) return Response.json({ jobs: [] });
    requests.push({ url, method: init.method });
    assert.equal(url, "/api/sessions/schedule");
    assert.equal(init.method, "POST");
    savedJob = { id: "saved-job", status: "pending" };
    await response;
    return Response.json({ policy: { mode: "fallback" }, jobs: [savedJob], session: created });
  };
  const view = render(React.createElement(ScheduleComposer, {
    newSessionCwd: "/tmp/workspace", models, currentModel,
    onSessionCreated: (session) => { selected = session.id; },
  }));
  const dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Save without stealing navigation");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await act(async () => { view.unmount(); });
  selected = "chat-b";
  render(React.createElement("div", null, "Chat B draft"));
  await act(async () => { release(); await response; });
  assert.equal(selected, "chat-b");
  assert.ok(screen.getByText("Chat B draft"));
  assert.deepEqual(savedJob, { id: "saved-job", status: "pending" });
  assert.equal(requests.some(({ method }) => method === "DELETE"), false, "navigation must never delete the created session or its job");
});

test("schedule text, model and timing survive closing and a fresh mount without leaking into the composer", async () => {
  const user = userEvent.setup();
  await mount();
  let dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Durable schedule only");
  await user.selectOptions(within(dialog).getByRole("combobox", { name: "Model" }), modelOption(dialog, "Other model — beta / other"));
  await user.click(within(dialog).getByRole("button", { name: "At a specific time" }));
  fireEvent.change(within(dialog).getByLabelText("Local date and time"), { target: { value: "2099-03-04T12:30" } });
  await user.click(within(within(dialog).getByRole("textbox", { name: "Prompt" }).closest("form")).getByRole("button", { name: "Close", exact: true }));
  await cleanupComposer();
  await mount({ models: models.filter(({ id }) => id !== "other") });
  dialog = await openSchedule(user);
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Durable schedule only");
  assert.equal(modelOption(dialog, /beta \/ other.*unavailable/i).selected, true);
  assert.equal(within(dialog).getByLabelText("Local date and time").value, "2099-03-04T12:30");
  assert.equal(within(dialog).getByRole("button", { name: "Schedule", exact: true }).disabled, true);
  await user.clear(within(dialog).getByRole("textbox", { name: "Prompt" }));
  await cleanupComposer();
  await mount();
  dialog = await openSchedule(user);
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "", "an explicitly deleted draft must not reappear");
});

test("schedule drafts stay scoped across chats and new workspaces even while the modal remains open", async () => {
  const user = userEvent.setup();
  globalThis.fetch = async () => Response.json({ policy: { mode: "fallback" }, jobs: [], reports: [] });
  const props = { currentModel, models, sessionId: "draft-a" };
  const view = render(React.createElement(ScheduleComposer, props));
  let dialog = await openSchedule(user);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "Chat A schedule" } });
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Hours" }), { target: { value: "7" } });
  for (const changes of [{ sessionId: "draft-b" }, { sessionId: undefined, newSessionCwd: "/tmp/one" }, { newSessionCwd: "/tmp/two" }]) {
    Object.assign(props, changes);
    await act(async () => view.rerender(React.createElement(ScheduleComposer, props)));
    dialog = screen.getByRole("dialog", { name: "Schedule prompt" });
    assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: props.sessionId ?? props.newSessionCwd } });
  }
  Object.assign(props, { sessionId: "draft-a" });
  await act(async () => view.rerender(React.createElement(ScheduleComposer, props)));
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Chat A schedule");
  assert.equal(within(dialog).getByRole("spinbutton", { name: "Hours" }).value, "7");
  Object.assign(props, { sessionId: undefined, newSessionCwd: "/tmp/one" });
  await act(async () => view.rerender(React.createElement(ScheduleComposer, props)));
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "/tmp/one");
});

test("switching same-cwd workspace isolates schedule drafts and restores the chosen workspace draft", async () => {
  const user = userEvent.setup();
  globalThis.fetch = async () => Response.json({ policy: { mode: "fallback" }, jobs: [], reports: [] });
  const props = { currentModel, models, newSessionCwd: "/same", newSessionWorkspaceId: "companion" };
  const view = render(React.createElement(ScheduleComposer, props));
  let dialog = await openSchedule(user);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "Companion schedule" } });
  props.newSessionWorkspaceId = "other";
  await act(async () => view.rerender(React.createElement(ScheduleComposer, props)));
  dialog = screen.getByRole("dialog", { name: "Schedule prompt" });
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "Other schedule" } });
  props.newSessionWorkspaceId = "companion";
  await act(async () => view.rerender(React.createElement(ScheduleComposer, props)));
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Companion schedule");
});

test("an ambiguous POST survives reload with the identical request and only confirmed success clears it", async () => {
  const user = userEvent.setup();
  const first = await mount({ onMutation() { throw new Error("Response lost"); } });
  let dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Retry after reopening browser");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.match(within(dialog).getByRole("alert").textContent, /Response lost/));
  const original = first.requests.find(({ method }) => method === "POST").body;
  await cleanupComposer();
  const second = await mount({ currentModel: null, models: [] });
  dialog = await openSchedule(user);
  assert.equal(within(dialog).getByRole("button", { name: "Schedule", exact: true }).disabled, false, "reconciliation does not require the model to remain available");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.deepEqual(second.requests.find(({ method }) => method === "POST").body, original);
  await cleanupComposer();
  await mount();
  dialog = await openSchedule(user);
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "");
});

test("manual resume edits never replace an unsubmitted schedule draft", async () => {
  const user = userEvent.setup();
  await mount({ jobs: [{ id: "waiting", kind: "resume", status: "waiting", runAt: null, prompt: "", provider: "saved", modelId: "pinned", createdAt: 1 }] });
  let dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Keep my new schedule");
  fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Hours" }), { target: { value: "8" } });
  await user.click(within(within(dialog).getByRole("textbox", { name: "Prompt" }).closest("form")).getByRole("button", { name: "Close", exact: true }));
  await user.click(screen.getByRole("button", { name: /Scheduled prompts/ }));
  await user.click(screen.getByRole("button", { name: "Set resume time" }));
  dialog = screen.getByRole("dialog", { name: "Set resume time" });
  fireEvent.change(within(dialog).getByLabelText("Local date and time"), { target: { value: "2099-05-06T12:00" } });
  await user.click(within(dialog).getByRole("button", { name: "Set resume time", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  await cleanupComposer();
  await mount();
  dialog = await openSchedule(user);
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Keep my new schedule");
  assert.equal(within(dialog).getByRole("spinbutton", { name: "Hours" }).value, "8");
});

test("an expired quota POST still reconciles identically after a fresh mount", async (t) => {
  const user = userEvent.setup();
  const resetAt = Date.now() + 3_600_000;
  const first = await mount({
    usage: { generatedAt: Date.now(), reports: [{ provider: "alpha", fiveHour: { percent: 100, resetsAt: resetAt } }] },
    onMutation() { throw new Error("Response lost"); },
  });
  let dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Reconcile old quota");
  await user.click(within(dialog).getByRole("button", { name: "Provider quota reset" }));
  const reset = await within(dialog).findByRole("combobox", { name: "Reported reset" });
  await user.selectOptions(reset, within(reset).getAllByRole("option").find((option) => option.value));
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.match(within(dialog).getByRole("alert").textContent, /Response lost/));
  const original = first.requests.find(({ method }) => method === "POST").body;
  await cleanupComposer();
  t.mock.method(Date, "now", () => resetAt + 1);
  const second = await mount();
  dialog = await openSchedule(user);
  const submit = within(dialog).getByRole("button", { name: "Schedule", exact: true });
  assert.equal(submit.disabled, false);
  await user.click(submit);
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.deepEqual(second.requests.find(({ method }) => method === "POST").body, original);
});

test("an old pending response cannot clear a newer draft after navigation and remount", async () => {
  const user = userEvent.setup();
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  await mount({ onMutation: () => response });
  let dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Original pending intent");
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await cleanupComposer();
  await mount();
  dialog = await openSchedule(user);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "A newer unsent schedule" } });
  await act(async () => { release(); await response; });
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "A newer unsent schedule");
  assert.equal(screen.getByRole("dialog", { name: "Schedule prompt" }), dialog, "the old response cannot close the current dialog");
  assert.equal(document.activeElement, within(dialog).getByRole("textbox", { name: "Prompt" }), "the old view cannot take focus from the newer draft");
  await cleanupComposer();
  await mount();
  dialog = await openSchedule(user);
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "A newer unsent schedule");
});

test("scheduled jobs stay collapsed while reading and failed records can be dismissed without cancelling", async () => {
  const user = userEvent.setup();
  const failed = { id: "failed-1", kind: "prompt", status: "failed", runAt: 1, prompt: "A long scheduled prompt that must not cover the conversation", error: "Invalid model response envelope", createdAt: 1, provider: "alpha", modelId: "shared:model" };
  const { requests } = await mount({
    jobs: [failed],
    onMutation({ body, snapshot }) {
      return { ...snapshot, jobs: snapshot.jobs.map(job => job.id === body.dismissJobId ? { ...job, dismissedAt: Date.now() } : job) };
    },
  });
  assert.ok(screen.queryByText(failed.prompt) === null, "job details do not occupy conversation space");
  await user.click(screen.getByRole("button", { name: /Scheduled prompts/ }));
  const manager = screen.getByRole("dialog", { name: "Scheduled prompts" });
  assert.ok(within(manager).getByText(failed.error));
  await user.click(within(manager).getByRole("button", { name: "Dismiss", exact: true }));
  await waitFor(() => assert.ok(within(manager).queryByRole("button", { name: "Dismiss", exact: true }) === null));
  assert.deepEqual(requests.find(request => request.method === "PUT").body, { dismissJobId: failed.id });
  assert.equal(requests.some(request => request.method === "DELETE"), false);
});

test("editing a scheduled prompt preserves its identity and does not replace the normal unsent schedule", async () => {
  const user = userEvent.setup();
  const job = { id: "edit-1", kind: "prompt", status: "pending", runAt: Date.now() + 3_600_000, prompt: "Original scheduled task", createdAt: 1, updatedAt: 2, provider: "alpha", modelId: "shared:model", thinkingLevel: "high" };
  const { requests } = await mount({
    jobs: [job],
    onMutation({ body, snapshot }) { return { ...snapshot, jobs: snapshot.jobs.map(item => item.id === body.jobId ? { ...item, ...body } : item) }; },
  });
  let dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Unsubmitted new schedule");
  await user.click(within(within(dialog).getByRole("textbox", { name: "Prompt" }).closest("form")).getByRole("button", { name: "Close", exact: true }));
  await user.click(screen.getByRole("button", { name: /Scheduled prompts/ }));
  await user.click(within(screen.getByRole("dialog", { name: "Scheduled prompts" })).getByRole("button", { name: "Edit", exact: true }));
  dialog = screen.getByRole("dialog", { name: "Edit scheduled prompt" });
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, job.prompt);
  await user.clear(within(dialog).getByRole("textbox", { name: "Prompt" }));
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "Edited task");
  await user.click(within(dialog).getByRole("button", { name: "Save changes", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Edit scheduled prompt" }), null));
  const update = requests.find(request => request.method === "PUT").body;
  assert.equal(update.jobId, job.id);
  assert.equal(update.prompt, "Edited task");
  assert.equal(update.thinkingLevel, "high");
  assert.equal(update.expectedUpdatedAt, job.updatedAt);
  assert.equal(requests.some(request => request.method === "POST"), false);
  dialog = await openSchedule(user);
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Unsubmitted new schedule");
});

test("new-chat scheduled slash discovery does not create the normal composer's conversation", async () => {
  const user = userEvent.setup();
  let normalLoads = 0;
  let scheduledLoads = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith("/api/commands?cwd=")) {
      scheduledLoads++;
      return Response.json({ commands: [{ name: "workspace-audit", description: "Audit this workspace", source: "extension" }] });
    }
    if (String(url).startsWith("/api/provider-usage")) return Response.json({ generatedAt: null, reports: [] });
    throw new Error(`Unexpected request ${url}`);
  };
  render(React.createElement(ScheduleComposer, {
    newSessionCwd: "/tmp/scheduled-workspace", currentModel, models,
    composerProps: {
      onSend() {}, onAbort() {}, isStreaming: false,
      onLoadSlashCommands: async () => { normalLoads++; return []; },
    },
  }));
  const dialog = await openSchedule(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Prompt" }), "/workspace");
  await waitFor(() => assert.equal(scheduledLoads, 1));
  assert.equal(normalLoads, 0, "discovering scheduled commands must not call ensureNewSession");
  assert.ok(await within(dialog).findByText("/workspace-audit"));
});

test("an accepted edit preserves newer text and advances its next revision token", async () => {
  const user = userEvent.setup();
  let release;
  let writes = 0;
  const job = { id: "pending-edit", kind: "prompt", status: "pending", runAt: Date.now() + 3_600_000, prompt: "Original", createdAt: 1, updatedAt: 2, provider: "alpha", modelId: "shared:model" };
  const { requests } = await mount({
    jobs: [job],
    async onMutation({ body, snapshot }) {
      if (++writes === 1) await new Promise(resolve => { release = resolve; });
      return { ...snapshot, jobs: [{ ...job, ...body, updatedAt: writes + 2 }] };
    },
  });
  await user.click(screen.getByRole("button", { name: /Scheduled prompts/ }));
  await user.click(within(screen.getByRole("dialog", { name: "Scheduled prompts" })).getByRole("button", { name: "Edit", exact: true }));
  const dialog = screen.getByRole("dialog", { name: "Edit scheduled prompt" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "First edit" } });
  await user.click(within(dialog).getByRole("button", { name: "Save changes", exact: true }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "Newer edit" } });
  await act(async () => { release(); });
  assert.equal(screen.getByRole("dialog", { name: "Edit scheduled prompt" }), dialog);
  assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Newer edit");
  await user.click(within(dialog).getByRole("button", { name: "Save changes", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Edit scheduled prompt" }), null));
  const second = requests.filter(request => request.method === "PUT")[1].body;
  assert.equal(second.prompt, "Newer edit");
  assert.equal(second.expectedUpdatedAt, 3);
});

test("scheduled Slow availability follows its selected model rather than the background chat", async () => {
  const user = userEvent.setup();
  await mount({
    models: [
      { provider: "alpha", id: "shared:model", name: "Regular", supportsSlowMode: false },
      { provider: "beta", id: "flex", name: "Flexible", supportsSlowMode: true },
    ],
    composerProps: { slowModeSupported: false },
  });
  const dialog = await openSchedule(user);
  const choice = within(dialog).getByRole("combobox", { name: "Model" });
  assert.equal(within(dialog).queryByRole("button", { name: "Slow", exact: true }), null);
  await user.selectOptions(choice, JSON.stringify(["beta", "flex"]));
  const slow = within(dialog).getByRole("button", { name: "Slow", exact: true });
  await user.click(slow);
  assert.equal(slow.getAttribute("aria-pressed"), "true");
  await user.selectOptions(choice, JSON.stringify(["alpha", "shared:model"]));
  assert.equal(within(dialog).queryByRole("button", { name: "Slow", exact: true }), null);
  await user.selectOptions(choice, JSON.stringify(["beta", "flex"]));
  assert.equal(within(dialog).getByRole("button", { name: "Slow", exact: true }).getAttribute("aria-pressed"), "false");
});

test("scheduled images and documents survive attachment and submission on plain HTTP", async (t) => {
  const user = userEvent.setup();
  const uuidDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  const previousReader = globalThis.FileReader;
  const previousFormData = globalThis.FormData;
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  globalThis.FileReader = window.FileReader;
  globalThis.FormData = window.FormData;
  t.mock.method(URL, "createObjectURL", () => "blob:schedule-http-proof");
  t.after(() => {
    if (uuidDescriptor) Object.defineProperty(globalThis.crypto, "randomUUID", uuidDescriptor);
    else delete globalThis.crypto.randomUUID;
    if (previousReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = previousReader;
    globalThis.FormData = previousFormData;
  });
  const { requests } = await mount({ composerProps: { cwd: "/workspace", onSend() {}, onAbort() {}, isStreaming: false } });
  const scheduleFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("?type=upload")) return Response.json({ uploaded: ["proof.txt"] });
    return scheduleFetch(url, init);
  };
  const dialog = await openSchedule(user);
  const input = dialog.querySelector('input[type="file"]');
  const file = new window.File(["private document body"], "proof.txt", { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
  await within(dialog).findByRole("button", { name: /Remove file/ });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const image = new window.File([png], "proof.png", { type: "image/png" });
  const readAsDataURL = window.FileReader.prototype.readAsDataURL;
  let readFinished;
  t.mock.method(window.FileReader.prototype, "readAsDataURL", function (value) {
    readFinished = new Promise(resolve => this.addEventListener("loadend", resolve, { once: true }));
    return readAsDataURL.call(this, value);
  });
  fireEvent.change(input, { target: { files: [image] } });
  await act(async () => { await readFinished; });
  await within(dialog).findByRole("button", { name: /Remove image/ });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "Inspect both attachments" } });
  await user.click(within(dialog).getByRole("button", { name: "Schedule", exact: true }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Schedule prompt" }), null));
  const saved = requests.find(request => request.method === "POST").body;
  assert.equal(saved.images[0].data, png.toString("base64"));
  assert.match(saved.prompt, /\/workspace\/proof\.txt/);
  assert.doesNotMatch(saved.prompt, /private document body/);
});

test("a partly hydrated schedule cannot submit until every saved photo is available", async () => {
  const key = `omp-web:schedule-draft:${JSON.stringify(["session", fixtureSessionId])}`;
  const payload = {
    prompt: "Keep all saved photos", model: currentModel, timingMode: "relative",
    resetKey: "", delayHours: "1", delayMinutes: "0", date: "",
    images: [{ data: "aGk=", mimeType: "image/png" }], imageKeys: ["newly-added"],
    missingImageCount: 1, request: null,
  };
  draftRecords.set(key, { key, revision: 1, payload, updatedAt: "2026-10-29T00:00:00Z" });
  const user = userEvent.setup();
  const { requests } = await mount();
  const dialog = await openSchedule(user);
  await waitFor(() => assert.equal(within(dialog).getByRole("textbox", { name: "Prompt" }).value, "Keep all saved photos"));
  await act(async () => { fireEvent.submit(dialog.querySelector("form")); });
  assert.equal(requests.filter(request => request.method === "POST").length, 0, "a new photo cannot hide a saved photo that has not hydrated");
  assert.equal(within(dialog).getByRole("button", { name: "Schedule", exact: true }).disabled, true);
});
