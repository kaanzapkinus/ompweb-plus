"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, ChevronRight, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { ExecutionJob, ExecutionModel, ExecutionPromptOptions, ExecutionSnapshot } from "@/lib/session-execution-types";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { useProviderUsage } from "./AppShell-provider-usage";
import type { SessionInfo } from "@/lib/types";
import { clearScheduleDraft, emptyScheduleDraft, readScheduleDraft, scheduleDraftKey, schedulePromptSignature, writeScheduleDraft, type ScheduleDraft } from "@/lib/schedule-draft";
import { ChatInput, type ChatInputProps } from "./ChatInput";
import type { ChatDraft } from "@/lib/draft-store";
import { composeMessageWithFileAttachments } from "@/lib/chat-attachments";
import { expandWebSlashCommand } from "@/lib/web-slash-commands";
import { toSlashCommandInfo } from "@/hooks/useAgentSession-stream";
import type { RpcAvailableSlashCommand } from "@/lib/pi-types";

const COPY = {
  en: {
    policy: "When the model limit is reached", fallback: "Allow fallback", wait: "Keep model, wait for quota",
    schedule: "Schedule prompt", scheduled: "Scheduled prompts", prompt: "Prompt", when: "When to send",
    quota: "Provider quota reset", relative: "After a delay", exact: "At a specific time",
    hours: "Hours", minutes: "Minutes", reportedReset: "Reported reset", chooseReset: "Choose a reported reset",
    quotaLoading: "Loading provider resets…", quotaError: "Provider reset data could not be loaded.",
    noReset: "No future reset time reported for this provider/model. Choose a delay or a local date and time.",
    invalidReset: "Choose a future provider-reported reset, or use manual timing.",
    quotaNote: "Uses this reported time only; it does not select an account or guarantee quota availability. Other limits may still apply.",
    providerWide: "Provider-wide", account: "Account",
    date: "Local date and time", save: "Schedule", cancel: "Cancel", close: "Close", saving: "Saving…",
    model: "Model", savedModel: "Saved model", modelRequired: "Choose a model.",
    modelUnavailable: "The selected model is unavailable. Choose an available model.", unavailable: "unavailable",
    chooseModel: "Choose a model", modelsLoading: "Loading models…", noModels: "No models available.",
    note: "Runs on the server with this model, without fallback. The server must remain awake and online.",
    empty: "No pending prompts.", pending: "Scheduled", waiting: "Waiting for quota", running: "Running",
    completed: "Completed", cancelled: "Cancelled", failed: "Failed", uncertain: "Delivery uncertain — check the conversation before sending again",
    unknown: "Provider did not report a reset time.", chooseTime: "Set resume time", resume: "Continue this conversation",
    invalidDate: "Choose a future date and time.", invalidDelay: "Enter at least 1 minute.", required: "Enter a prompt.",
    retry: "Refresh", waitHint: "Quota waiting is enabled for this conversation only.", resumeTitle: "Set resume time",
    edit: "Edit", editTitle: "Edit scheduled prompt", saveChanges: "Save changes", dismiss: "Dismiss",
    manage: "Manage schedules", history: "History", add: "New scheduled prompt", stop: "Stop",
    attachmentsMissing: "Image drafts are kept in memory only. Reattach the images before scheduling. An already accepted request will be recovered without sending again.",
    recovering: "Checking the saved request…", noSavedRequest: "No accepted schedule was found. Check recent conversations before creating a new request, then reattach your images.",
    noJobs: "No active schedules.", localStart: "Local start",
  },
};

const activeJob = (job: ExecutionJob) => job.status === "pending" || job.status === "waiting" || job.status === "running";
type ScheduleModel = { provider: string; id: string; name?: string; supportsFastMode?: boolean; supportsSlowMode?: boolean };
type SessionExecutionControlsProps = {
  sessionId?: string;
  newSessionCwd?: string | null;
  onSessionCreated?: (session: SessionInfo) => void;
  currentModel?: ExecutionModel | null;
  models?: readonly ScheduleModel[];
  modelsLoading?: boolean;
  composerProps?: ChatInputProps;
  thinkingLevelsByModel?: Record<string, string[] | null>;
  thinkingMapsByModel?: Record<string, Record<string, string | null> | null>;
  onStop?: (job: ExecutionJob) => void;
  scheduleOpen: boolean;
  onScheduleOpenChange: (open: boolean) => void;
  onScheduleAvailabilityChange?: (available: boolean) => void;
  scheduleReturnFocus?: () => HTMLElement | null;
  policyContainer?: HTMLElement | null;
};
const EMPTY_MODELS: readonly ScheduleModel[] = [];
const modelKey = (provider: string, id: string) => JSON.stringify([provider, id]);
function formatDelay(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

export function SessionExecutionControls({ sessionId, newSessionCwd, onSessionCreated, currentModel, models = EMPTY_MODELS, modelsLoading = false, composerProps, thinkingLevelsByModel, thinkingMapsByModel, onStop, scheduleOpen, onScheduleOpenChange, onScheduleAvailabilityChange, scheduleReturnFocus, policyContainer }: SessionExecutionControlsProps) {
  const { locale } = useI18n();
  const copy = COPY.en;
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const version = useRef(0);
  const navigationGeneration = useRef(0);
  const promptRequest = useRef<ScheduleDraft["request"]>(null);
  const createdSession = useRef<SessionInfo | null>(null);
  const scheduleWasOpen = useRef(false);
  const manualReturnFocus = useRef<HTMLButtonElement | null>(null);
  const [manualJob, setManualJob] = useState<ExecutionJob | null>(null);
  const [editingJob, setEditingJob] = useState<ExecutionJob | null>(null);
  const [managerOpen, setManagerOpenState] = useState(false);
  const managerOpenRef = useRef(false);
  const setManagerOpen = (value: boolean) => { managerOpenRef.current = value; setManagerOpenState(value); };
  const editorSequence = useRef(0);
  const [scheduleCommands, setScheduleCommands] = useState<ChatInputProps["slashCommands"]>();
  const [commandsLoading, setCommandsLoading] = useState(false);
  const open = scheduleOpen || manualJob !== null || editingJob !== null;
  const draftKey = scheduleDraftKey(sessionId, newSessionCwd);
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  const composerPropsRef = useRef(composerProps);
  composerPropsRef.current = composerProps;
  const [form, setForm] = useState(() => emptyScheduleDraft(currentModel ?? null));
  const formRef = useRef(form);
  const savedDraft = useRef({ key: draftKey, value: form, touched: false });
  const { prompt, model: draftModel, timingMode, resetKey, delayHours, delayMinutes, date } = form;
  const replaceForm = useCallback((value: ScheduleDraft) => {
    formRef.current = value;
    setForm(value);
  }, []);
  const newDraft = useCallback((): ScheduleDraft => {
    const composer = composerPropsRef.current;
    return {
      ...emptyScheduleDraft(currentModelRef.current ?? null),
      ...(composer ? {
        thinkingLevel: composer.thinkingLevel, toolPreset: composer.toolPreset,
        fastMode: composer.fastModeSupported ? composer.fastModeEnabled : undefined,
        slowMode: composer.slowModeSupported ? composer.slowModeEnabled : undefined,
        advisorEnabled: composer.advisorEnabled,
      } : {}),
    };
  }, []);
  const updateForm = (patch: Partial<ScheduleDraft>) => {
    const value = { ...formRef.current, ...patch };
    replaceForm(value);
    if (!manualJob && !editingJob) {
      savedDraft.current = { key: draftKey, value, touched: true };
      writeScheduleDraft(draftKey, value);
    }
  };
  const changeModel = (provider: string, modelId: string) => {
    const levels = thinkingLevelsByModel?.[`${provider}:${modelId}`];
    const thinkingLevel = formRef.current.thinkingLevel;
    updateForm({
      model: { provider, modelId }, resetKey: "",
      slowMode: false,
      ...(levels && thinkingLevel && thinkingLevel !== "auto" && !levels.includes(thinkingLevel) ? { thinkingLevel: "off" } : {}),
    });
  };
  const endpoint = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/execution` : "/api/sessions/schedule";
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ScheduleModel[]>();
    for (const model of models) {
      const group = groups.get(model.provider);
      if (group) group.push(model);
      else groups.set(model.provider, [model]);
    }
    return Array.from(groups);
  }, [models]);
  const draftModelAvailable = Boolean(draftModel && models.some((model) => model.provider === draftModel.provider && model.id === draftModel.modelId));
  const schedulingModel = manualJob ?? draftModel;
  const schedulingProvider = schedulingModel?.provider;
  const schedulingModelId = schedulingModel?.modelId;
  // Request every scope for the provider: the catalog's model id must match
  // exactly, and provider-wide limits must not be hidden by model prioritization.
  const usage = useProviderUsage(open && schedulingProvider ? `provider=${encodeURIComponent(schedulingProvider)}` : null, undefined, true);
  const resets = useMemo(() => {
    if (!schedulingProvider || !schedulingModelId) return [];
    const now = Date.now();
    return (usage.snapshot?.reports ?? []).flatMap((report) => {
      if (report.provider !== schedulingProvider || (report.modelId !== undefined && report.modelId !== schedulingModelId)) return [];
      return ([
        ["fiveHour", "5h"],
        ["sevenDay", "7d"],
        ["monthly", "Monthly"],
      ] as const).flatMap(([windowKey, label]) => {
        const window = report[windowKey];
        const runAt = window?.resetsAt;
        if (!window || typeof runAt !== "number" || !Number.isFinite(runAt) || runAt <= now) return [];
        return [{
          key: JSON.stringify([report.provider, report.accountLabel, report.accountIndex, report.modelId, report.tier, windowKey, runAt]),
          runAt,
          label: [
            report.accountLabel ?? (report.accountIndex ? `${copy.account} ${report.accountIndex}` : report.provider),
            report.modelId ?? copy.providerWide,
            report.tier,
            `${label} · ${Math.round(window.percent)}%`,
          ].filter(Boolean).join(" · "),
        }];
      });
    });
  }, [usage.snapshot, schedulingProvider, schedulingModelId, copy]);
  const selectedReset = resets.find((reset) => reset.key === resetKey);
  const totalDelay = () => {
    const hours = Number(delayHours);
    const minutes = Number(delayMinutes);
    return Number.isInteger(hours) && hours >= 0 && Number.isInteger(minutes) && minutes >= 0
      ? hours * 60 + minutes
      : NaN;
  };
  const normalizeDelay = () => {
    const total = totalDelay();
    if (!Number.isFinite(total)) return;
    updateForm({ delayHours: String(Math.floor(total / 60)), delayMinutes: String(total % 60) });
  };
  // Intent identity comes from the draft, not the refreshed reset options:
  // a disappeared reset must not turn an uncertain POST into a new request.
  const promptSignature = schedulePromptSignature(form);
  const retryPrompt = !manualJob && promptRequest.current?.signature === promptSignature ? promptRequest.current.body : null;
  const previewTime = timingMode === "relative" ? Date.now() + totalDelay() * 60_000
    : timingMode === "quota" ? selectedReset?.runAt ?? NaN
    : new Date(date).getTime();

  const request = useCallback(async (method: string, body?: object, query = "") => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(endpoint + query, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(!sessionId && method === "POST" ? { ...body, cwd: newSessionCwd } : body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
      const data = await response.json() as ExecutionSnapshot & { error?: string; session?: SessionInfo };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }, [endpoint, sessionId, newSessionCwd]);

  const refresh = useCallback(async () => {
    if (pending.current || !sessionId) return;
    const current = ++version.current;
    try {
      const data = await request("GET");
      if (version.current !== current) return;
      setSnapshot(data);
      setError(null);
    } catch (cause) {
      if (version.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [request, sessionId]);
  const invalidateRefresh = useCallback(() => { version.current++; }, []);
  const loadScheduleCommands = async () => {
    if (sessionId && composerProps?.onLoadSlashCommands) return composerProps.onLoadSlashCommands();
    const cwd = newSessionCwd ?? composerProps?.cwd;
    if (!cwd) return [];
    const generation = navigationGeneration.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    setCommandsLoading(true);
    try {
      const response = await fetch(`/api/commands?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json() as { commands?: RpcAvailableSlashCommand[]; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const commands = (data.commands ?? []).map(toSlashCommandInfo).filter(command => command !== null);
      if (navigationGeneration.current === generation) setScheduleCommands(commands);
      return commands;
    } catch (cause) {
      if (navigationGeneration.current === generation) setFormError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      clearTimeout(timer);
      if (navigationGeneration.current === generation) setCommandsLoading(false);
    }
  };

  useEffect(() => {
    const generation = ++navigationGeneration.current;
    pending.current = false;
    setBusy(false);
    const restored = readScheduleDraft(draftKey);
    const value = restored ?? newDraft();
    savedDraft.current = { key: draftKey, value, touched: restored !== null };
    formRef.current = value;
    setForm(value);
    if (restored) writeScheduleDraft(draftKey, restored);
    promptRequest.current = value.request;
    createdSession.current = null;
    setEditingJob(null);
    setManagerOpen(false);
    setScheduleCommands(undefined);
    setCommandsLoading(false);
    editorSequence.current++;
    setManualJob(null);
    setFormError(null);
    setSnapshot(null);
    setError(null);
    return () => {
      navigationGeneration.current = generation + 1;
      invalidateRefresh();
    };
  }, [draftKey, invalidateRefresh, newDraft]);

  useEffect(() => {
    if (!sessionId) return;
    void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(onVisible, 15_000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      invalidateRefresh();
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, invalidateRefresh, sessionId]);

  const mutate = async (method: string, body: object, form = false, onAccepted?: (data: ExecutionSnapshot) => void) => {
    if (pending.current) return false;
    const generation = navigationGeneration.current;
    pending.current = true;
    invalidateRefresh();
    setBusy(true);
    const reportError = form ? setFormError : setError;
    reportError(null);
    try {
      const data = await request(method, body);
      // The durable operation still succeeds, but an obsolete view must not
      // publish its state or promote its newly created chat after navigation.
      if (navigationGeneration.current !== generation) return false;
      setSnapshot(data);
      onAccepted?.(data);
      if (data.session) createdSession.current = data.session;
      return true;
    } catch (cause) {
      if (navigationGeneration.current === generation) reportError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (navigationGeneration.current === generation) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const jobs = snapshot?.jobs ?? [];
  const scheduleAvailable = !busy && Boolean(sessionId ? snapshot : newSessionCwd);
  const visibleJobs = jobs.filter((job) => !job.dismissedAt && (activeJob(job) || job.status === "failed" || job.status === "uncertain"));
  const dateLabel = (value: number) => new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
  useEffect(() => {
    onScheduleAvailabilityChange?.(scheduleAvailable);
  }, [onScheduleAvailabilityChange, scheduleAvailable]);
  useEffect(() => {
    if (scheduleOpen && !scheduleWasOpen.current) {
      manualReturnFocus.current = null;
      setEditingJob(null);
      setManagerOpen(false);
      editorSequence.current++;
      setManualJob(null);
      const value = savedDraft.current.touched
        ? readScheduleDraft(draftKey) ?? savedDraft.current.value
        : newDraft();
      savedDraft.current.value = value;
      if (savedDraft.current.touched) writeScheduleDraft(draftKey, value);
      replaceForm(value);
      promptRequest.current = value.request;
      setFormError(null);
    }
    scheduleWasOpen.current = scheduleOpen;
  }, [scheduleOpen, currentModel, draftKey, replaceForm, newDraft]);
  const close = () => {
    if (pending.current) return;
    onScheduleOpenChange(false);
    if (manualJob) replaceForm(savedDraft.current.value);
    setManualJob(null);
    if (editingJob) replaceForm(savedDraft.current.value);
    setEditingJob(null);
    setFormError(null);
  };
  const editJob = async (job: ExecutionJob, trigger: HTMLButtonElement) => {
    if (pending.current) return;
    manualReturnFocus.current = trigger;
    const generation = navigationGeneration.current;
    if ((job.imageCount ?? 0) > 0 && !job.images?.length) {
      pending.current = true;
      invalidateRefresh();
      setBusy(true);
      setError(null);
      try {
        const data = await request("GET", undefined, `?jobId=${encodeURIComponent(job.id)}`);
        if (navigationGeneration.current !== generation || !managerOpenRef.current) return;
        const detail = data.jobs.find(item => item.id === job.id);
        if (!detail || detail.images?.length !== job.imageCount) throw new Error("Scheduled images could not be loaded. Try Edit again; no changes were made.");
        job = detail;
      } catch (cause) {
        if (navigationGeneration.current === generation) setError(cause instanceof Error ? cause.message : String(cause));
        return;
      } finally {
        if (navigationGeneration.current === generation) { pending.current = false; setBusy(false); }
      }
    }
    setManagerOpen(false);
    setEditingJob(job);
    editorSequence.current++;
    const date = job.runAt === null ? "" : new Date(job.runAt - new Date(job.runAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    replaceForm({
      ...emptyScheduleDraft(job),
      prompt: job.prompt, date, timingMode: "exact",
      thinkingLevel: job.thinkingLevel, toolPreset: job.toolPreset,
      fastMode: job.fastMode, slowMode: job.slowMode, advisorEnabled: job.advisorEnabled,
      images: job.images, imageKeys: job.images?.map(() => crypto.randomUUID()),
    });
    setFormError(null);
  };
  const composerDraft: ChatDraft = { value: prompt, images: form.images ?? [], files: form.files ?? [] };
  const changeComposerDraft = (draft: ChatDraft) => {
    const imagesChanged = draft.images.length !== (formRef.current.images?.length ?? 0)
      || draft.images.some((image, index) => image.data !== formRef.current.images?.[index]?.data || image.mimeType !== formRef.current.images?.[index]?.mimeType);
    updateForm({
      prompt: draft.value, images: draft.images, files: draft.files,
      ...(imagesChanged ? { imageKeys: draft.images.map(() => crypto.randomUUID()), missingImageCount: 0 } : {}),
    });
  };
  const optionsFor = (draft: ScheduleDraft): ExecutionPromptOptions => ({
    ...(draft.images?.length ? { images: draft.images } : {}),
    ...(draft.thinkingLevel !== undefined ? { thinkingLevel: draft.thinkingLevel } : {}),
    ...(draft.toolPreset !== undefined ? { toolPreset: draft.toolPreset } : {}),
    ...(draft.fastMode !== undefined ? { fastMode: draft.fastMode } : {}),
    ...(draft.slowMode !== undefined ? { slowMode: draft.slowMode } : {}),
    ...(draft.advisorEnabled !== undefined ? { advisorEnabled: draft.advisorEnabled } : {}),
  });
  const submit = async (composedPrompt?: string) => {
    if (pending.current) return false;
    const generation = navigationGeneration.current;
    if (!retryPrompt && timingMode === "quota" && (usage.loading || usage.error)) { setFormError(copy.quotaError); return false; }
    let runAt: number;
    if (timingMode === "quota") runAt = selectedReset?.runAt ?? NaN;
    else if (timingMode === "exact") runAt = new Date(date).getTime();
    else {
      const totalMinutes = totalDelay();
      if (!Number.isFinite(totalMinutes) || totalMinutes < 1) { setFormError(copy.invalidDelay); return false; }
      runAt = Date.now() + totalMinutes * 60_000;
    }
    if (manualJob) {
      if (!Number.isFinite(runAt) || runAt <= Date.now()) { setFormError(copy.invalidDate); return false; }
      if (await mutate("PUT", { resumeAt: runAt, jobId: manualJob.id }, true) && navigationGeneration.current === generation) close();
      return false;
    }
    const current = formRef.current;
    let message = composedPrompt;
    if (message === undefined) {
      const expansion = expandWebSlashCommand(current.prompt.trim());
      if (expansion.kind === "usage-error") { setFormError(`/${expansion.command.replace(/^\//, "")} requires an argument.`); return false; }
      message = composeMessageWithFileAttachments(expansion.kind === "expand" ? expansion.prompt : current.prompt.trim(), current.files ?? []);
    }
    if ((current.missingImageCount ?? 0) > 0 && !current.images?.length && !retryPrompt) { setFormError(copy.attachmentsMissing); return false; }
    if (!retryPrompt) {
      if (!message.trim() && !current.images?.length) { setFormError(copy.required); return false; }
      if (!draftModel) { setFormError(copy.modelRequired); return false; }
      if (!draftModelAvailable) { setFormError(copy.modelUnavailable); return false; }
    }
    if (editingJob) {
      if (!Number.isFinite(runAt) || runAt <= Date.now()) { setFormError(copy.invalidDate); return false; }
      let saved: ExecutionJob | undefined;
      const accepted = await mutate("PUT", { jobId: editingJob.id, expectedUpdatedAt: editingJob.updatedAt ?? editingJob.createdAt, prompt: message, runAt, ...draftModel, ...optionsFor(current) }, true,
        data => { saved = data.jobs.find(job => job.id === editingJob.id); });
      if (accepted && navigationGeneration.current === generation) {
        if (schedulePromptSignature(formRef.current) === schedulePromptSignature(current)) close();
        else if (saved) setEditingJob(saved);
      }
      return false;
    }
    let draft = promptRequest.current;
    if (!draft || draft.signature !== promptSignature) {
      if (!draftModel) { setFormError(copy.modelRequired); return false; }
      if (!Number.isFinite(runAt) || runAt <= Date.now()) { setFormError(timingMode === "quota" ? copy.invalidReset : timingMode === "exact" ? copy.invalidDate : copy.invalidDelay); return false; }
      const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
      draft = { signature: promptSignature, body: { prompt: message, runAt, ...draftModel, ...optionsFor(current), requestId } };
      promptRequest.current = draft;
      updateForm({ request: draft });
    }
    const submitted = savedDraft.current.value;
    let accepted = false;
    if ((draft.imageCount ?? 0) > 0 && !draft.body.images?.length) {
      pending.current = true;
      invalidateRefresh();
      setBusy(true);
      setFormError(null);
      try {
        const data = await request("GET", undefined, sessionId ? "" : `?requestId=${encodeURIComponent(draft.body.requestId)}`);
        if (navigationGeneration.current !== generation) return false;
        if (!data.jobs?.some(job => job.requestId === draft!.body.requestId)) throw new Error(copy.noSavedRequest);
        setSnapshot(data);
        if (data.session) createdSession.current = data.session;
        accepted = true;
      } catch (cause) {
        if (navigationGeneration.current === generation) setFormError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (navigationGeneration.current === generation) { pending.current = false; setBusy(false); }
      }
    } else accepted = await mutate("POST", draft.body, true);
    if (accepted && navigationGeneration.current === generation) {
      if (savedDraft.current.value !== submitted || !clearScheduleDraft(draftKey, submitted)) return false;
      promptRequest.current = null;
      const empty = newDraft();
      savedDraft.current = { key: draftKey, value: empty, touched: false };
      replaceForm(empty);
      close();
      if (createdSession.current) onSessionCreated?.(createdSession.current);
    }
    // The controller, not a now-unmounted composer, clears the accepted snapshot.
    return false;
  };

  return (
    <section className={sessionId && (visibleJobs.length || error) ? "execution-controls" : undefined} aria-label={copy.scheduled}>
      {sessionId && policyContainer && createPortal(
        <div role="group" aria-label={copy.policy} style={{ borderBottom: "1px solid var(--border)", padding: "4px 0" }}>
          <div className="picker-panel-header"><span className="picker-panel-title">{copy.policy}</span></div>
          {(["fallback", "wait"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="menuitemradio"
              aria-checked={snapshot?.policy.mode === mode}
              disabled={!snapshot}
              aria-disabled={busy || !snapshot}
              onClick={() => { if (!busy && snapshot && snapshot.policy.mode !== mode) void mutate("PUT", { mode }); }}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", border: "none", background: snapshot?.policy.mode === mode ? "var(--bg-hover)" : "none", color: "var(--text)", textAlign: "left", fontSize: 12, cursor: busy || !snapshot ? "default" : "pointer", opacity: busy || !snapshot ? 0.5 : 1 }}
            >
              <span aria-hidden="true" style={{ width: 12, flexShrink: 0 }}>{snapshot?.policy.mode === mode ? "●" : "○"}</span>
              {copy[mode]}
            </button>
          ))}
          {snapshot?.policy.mode === "wait" && <p className="execution-hint" style={{ padding: "0 10px" }}>{copy.waitHint}</p>}
          {jobs.length > 0 && <button type="button" role="menuitem" onClick={() => setManagerOpen(true)}>{copy.manage}</button>}
        </div>,
        policyContainer,
      )}
      {error && <div role="alert" className="execution-error">{error}<button type="button" onClick={() => void refresh()} disabled={busy}>{copy.retry}</button></div>}
      {visibleJobs.length > 0 && <button type="button" className="execution-summary" aria-haspopup="dialog" onClick={() => setManagerOpen(true)}>
        <CalendarClock size={14} aria-hidden="true" />
        <span>{copy.scheduled} ({visibleJobs.length})</span>
        <span className="execution-summary-status">{visibleJobs.some(job => job.status === "running") ? copy.running : visibleJobs.some(job => job.status === "failed" || job.status === "uncertain") ? copy.failed : copy.pending}</span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>}
      <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
        <DialogContent className="execution-dialog execution-manager" viewportBound>
          <div className="execution-dialog-header"><DialogTitle>{copy.scheduled}</DialogTitle><button type="button" aria-label={copy.close} onClick={() => setManagerOpen(false)}><X size={16} /></button></div>
          <div className="execution-dialog-body">
            {error && <p role="alert" className="execution-error">{error}</p>}
            {visibleJobs.length === 0 && <p className="execution-hint">{copy.noJobs}</p>}
            <ul className="execution-jobs">{visibleJobs.map(job => (
              <li key={job.id}>
                <div className="execution-job-text">
                  <strong>{copy[job.status]}</strong>
                  <span>{job.kind === "resume" ? copy.resume : job.prompt}</span>
                  <small>{job.provider} / {job.modelId}{job.runAt !== null ? ` · ${dateLabel(job.runAt)}` : ""}{job.thinkingLevel ? ` · ${job.thinkingLevel}` : ""}{job.imageCount ? ` · ${job.imageCount} image(s)` : ""}</small>
                  {job.status === "waiting" && job.runAt === null && <small>{copy.unknown}</small>}
                  {job.error && <small className="execution-error">{job.error}</small>}
                </div>
                <div className="execution-job-actions">
                  {(job.status === "pending" || job.status === "waiting") && job.kind === "prompt" && !job.continuation && <button type="button" disabled={busy} onClick={event => void editJob(job, event.currentTarget)}>{copy.edit}</button>}
                  {(job.status === "waiting" || (job.status === "pending" && job.kind === "resume")) && <button type="button" disabled={busy} onClick={event => {
                    manualReturnFocus.current = event.currentTarget;
                    setManagerOpen(false);
                    setManualJob(job);
                    replaceForm({ ...savedDraft.current.value, timingMode: "exact", resetKey: "", delayHours: "3", delayMinutes: "0", date: "" });
                    setFormError(null);
                  }}>{copy.chooseTime}</button>}
                  {(job.status === "pending" || job.status === "waiting") && <button type="button" disabled={busy} onClick={() => void mutate("DELETE", { jobId: job.id })}>{copy.cancel}</button>}
                  {job.status === "running" && onStop && (!/^\/btw(?:\s|$)/.test(job.prompt) || job.btwId) && <button type="button" disabled={busy} onClick={() => onStop(job)}>{copy.stop}</button>}
                  {!activeJob(job) && <button type="button" disabled={busy} onClick={() => void mutate("PUT", { dismissJobId: job.id })}>{copy.dismiss}</button>}
                </div>
              </li>
            ))}</ul>
            {jobs.some(job => !visibleJobs.includes(job)) && <details className="execution-history"><summary>{copy.history}</summary><ul className="execution-jobs">{jobs.filter(job => !visibleJobs.includes(job)).map(job => <li key={job.id}><div className="execution-job-text"><strong>{copy[job.status]}</strong><span>{job.kind === "resume" ? copy.resume : job.prompt}</span><small>{dateLabel(job.createdAt)} · {job.provider} / {job.modelId}</small></div></li>)}</ul></details>}
          </div>
          <div className="execution-dialog-actions"><button type="button" onClick={() => { setManagerOpen(false); onScheduleOpenChange(true); }}>{copy.add}</button><button type="button" onClick={() => setManagerOpen(false)}>{copy.close}</button></div>
        </DialogContent>
      </Dialog>
      <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
        <DialogContent className="execution-dialog" viewportBound finalFocus={() => manualReturnFocus.current?.isConnected ? manualReturnFocus.current : scheduleReturnFocus?.() ?? null}>
          <div className="execution-dialog-header"><DialogTitle style={{ margin: 0 }}>{manualJob ? copy.resumeTitle : editingJob ? copy.editTitle : copy.schedule}</DialogTitle><button type="button" aria-label={copy.close} disabled={busy} onClick={close}><X size={16} /></button></div>
          <form onSubmit={event => { event.preventDefault(); void submit(); }}>
            <div className="execution-dialog-body">
            {manualJob ? <p className="execution-model">{copy.savedModel}: {manualJob.provider} / {manualJob.modelId}</p> : <>
              <label>{copy.model}<select value={draftModel ? modelKey(draftModel.provider, draftModel.modelId) : ""} disabled={busy} onChange={(event) => {
                const model = models.find((option) => modelKey(option.provider, option.id) === event.target.value);
                if (model) {
                  changeModel(model.provider, model.id);
                }
              }}>
                {!draftModel && <option value="" disabled>{copy.chooseModel}</option>}
                {draftModel && !draftModelAvailable && <option value={modelKey(draftModel.provider, draftModel.modelId)} disabled>{draftModel.provider} / {draftModel.modelId} — {copy.unavailable}</option>}
                {modelGroups.map(([provider, options]) => <optgroup key={provider} label={provider}>
                  {options.map((model) => <option key={modelKey(model.provider, model.id)} value={modelKey(model.provider, model.id)}>{model.name ? `${model.name} — ` : ""}{model.provider} / {model.id}</option>)}
                </optgroup>)}
              </select></label>
              {modelsLoading ? <p role="status" className="execution-hint">{copy.modelsLoading}</p> : models.length === 0 && <p className="execution-hint">{copy.noModels}</p>}
            </>}
            <fieldset className="execution-timing" disabled={busy}>
              <legend>{copy.when}</legend>
              <div className="execution-timing-tabs" role="group" aria-label={copy.when}>
                <button type="button" aria-pressed={timingMode === "quota"} onClick={() => updateForm({ timingMode: "quota" })}>{copy.quota}</button>
                <button type="button" aria-pressed={timingMode === "relative"} onClick={() => updateForm({ timingMode: "relative" })}>{copy.relative}</button>
                <button type="button" aria-pressed={timingMode === "exact"} onClick={() => updateForm({ timingMode: "exact" })}>{copy.exact}</button>
              </div>
              {timingMode === "quota" ? (
                <div className="execution-quota-fields">
                  {usage.loading ? <p role="status" className="execution-hint">{copy.quotaLoading}</p> : usage.error ? (
                    <p role="status" className="execution-hint">{copy.quotaError}</p>
                  ) : resets.length > 0 ? (
                    <label>{copy.reportedReset}<select value={selectedReset?.key ?? ""} onChange={(event) => updateForm({ resetKey: event.target.value })} required={!retryPrompt}>
                      <option value="" disabled>{copy.chooseReset}</option>
                      {resets.map((reset) => <option key={reset.key} value={reset.key}>{reset.label} · {dateLabel(reset.runAt)}</option>)}
                    </select></label>
                  ) : <p role="status" className="execution-hint">{copy.noReset}</p>}
                  <button type="button" onClick={() => void usage.refresh()} disabled={usage.loading || !schedulingModel}>{copy.retry}</button>
                  <p className="execution-hint">{copy.quotaNote}</p>
                </div>
              ) : timingMode === "relative" ? (
                <div className="execution-delay-fields">
                  <label className="execution-delay-label">{copy.hours}<input type="number" min="0" step="1" value={delayHours} onChange={(event) => updateForm({ delayHours: event.target.value })} onBlur={normalizeDelay} /></label>
                  <label className="execution-delay-label">{copy.minutes}<input type="number" min="0" step="1" value={delayMinutes} onChange={(event) => updateForm({ delayMinutes: event.target.value })} onBlur={normalizeDelay} /></label>
                  {Number.isFinite(totalDelay()) && totalDelay() > 0 && (
                    <span className="execution-delay-preview" aria-live="polite">{formatDelay(totalDelay())}</span>
                  )}
                </div>
              ) : (
                <label>{copy.date}<input autoFocus={Boolean(manualJob)} type="datetime-local" value={date} onChange={(event) => updateForm({ date: event.target.value })} required /></label>
              )}
              {Number.isFinite(previewTime) && <p className="execution-hint" aria-live="polite">{copy.localStart}: {dateLabel(previewTime)}</p>}
            </fieldset>
            <p className="execution-hint">{copy.note}</p>
            {formError && <p role="alert" className="execution-error">{formError}</p>}
            {!manualJob && <>
              {(form.missingImageCount ?? 0) > 0 && !form.images?.length && <p role="status" className="execution-hint">{copy.attachmentsMissing}</p>}
              {retryPrompt && (form.request?.imageCount ?? 0) > 0 && !retryPrompt.images?.length && <button type="button" disabled={busy} onClick={() => void submit()}>{copy.recovering}</button>}
              <ChatInput
                {...composerProps}
                key={`${draftKey}:${editingJob?.id ?? "new"}:${editorSequence.current}`}
                draftKey={`schedule:${draftKey}:${editingJob?.id ?? "new"}`}
                draft={composerDraft}
                onDraftChange={changeComposerDraft}
                inputLabel={copy.prompt}
                autoFocus
                deferCommands
                cwd={newSessionCwd ?? composerProps?.cwd}
                model={draftModel}
                modelList={models.map(model => ({ ...model, name: model.name ?? model.id }))}
                modelNameOverride={null}
                isAutoModelSelection={false}
                modelsLoading={modelsLoading}
                slashCommands={scheduleCommands ?? composerProps?.slashCommands}
                slashCommandsLoading={commandsLoading || composerProps?.slashCommandsLoading}
                onLoadSlashCommands={loadScheduleCommands}
                onModelChange={changeModel}
                thinkingLevel={form.thinkingLevel ?? "off"}
                onThinkingLevelChange={thinkingLevel => updateForm({ thinkingLevel })}
                availableThinkingLevels={draftModel ? thinkingLevelsByModel?.[`${draftModel.provider}:${draftModel.modelId}`] : null}
                thinkingLevelMap={draftModel ? thinkingMapsByModel?.[`${draftModel.provider}:${draftModel.modelId}`] : null}
                toolPreset={form.toolPreset ?? "full"}
                onToolPresetChange={toolPreset => updateForm({ toolPreset })}
                fastModeEnabled={form.fastMode ?? false}
                fastModeSupported={Boolean(models.find(model => model.provider === draftModel?.provider && model.id === draftModel?.modelId)?.supportsFastMode)}
                onFastModeChange={fastMode => updateForm({ fastMode })}
                slowModeEnabled={form.slowMode ?? false}
                slowModeSupported={Boolean(models.find(model => model.provider === draftModel?.provider && model.id === draftModel?.modelId)?.supportsSlowMode)}
                onSlowModeChange={slowMode => updateForm({ slowMode })}
                slowModeScope="session"
                advisorEnabled={form.advisorEnabled ?? false}
                onAdvisorChange={advisorEnabled => updateForm({ advisorEnabled })}
                isStreaming={false}
                onSend={message => submit(message)}
                onAbort={close}
                onBuiltinCommand={async text => {
                  if (!/^\/(?:copy|session|btw)\s*$/.test(text) || !sessionId || !composerProps?.onBuiltinCommand) return { handled: false };
                  if (!text.startsWith("/copy")) close();
                  return composerProps.onBuiltinCommand(text);
                }}
                onSchedulePrompt={undefined}
                onExecutionPolicyContainerChange={undefined}
                onSteer={undefined}
                onFollowUp={undefined}
                onPromptWithStreamingBehavior={undefined}
                onRemoveQueuedMessage={undefined}
                queuedMessages={undefined}
                onMinimize={undefined}
                statusText={undefined}
                sessionInfoContainer={undefined}
                onCompact={undefined}
                isCompacting={false}
                compactResult={undefined}
                retryInfo={undefined}
                usageLimit={undefined}
                submitLabel={busy ? copy.saving : editingJob ? copy.saveChanges : copy.save}
                submitDisabled={busy || (!retryPrompt && ((timingMode === "quota" && (!selectedReset || usage.loading || Boolean(usage.error))) || !draftModelAvailable || Boolean((form.missingImageCount ?? 0) > 0 && !form.images?.length)))}
              />
            </>}
            </div>
            <div className="execution-dialog-actions"><button type="button" disabled={busy} onClick={close}>{copy.close}</button>{manualJob && <button type="submit" disabled={busy || (timingMode === "quota" && !selectedReset)}>{busy ? copy.saving : copy.chooseTime}</button>}</div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
