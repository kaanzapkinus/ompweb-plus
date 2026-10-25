import type { ToolPreset } from "./tool-presets";

export interface ExecutionPromptOptions {
  images?: { data: string; mimeType: string }[];
  thinkingLevel?: string;
  toolPreset?: ToolPreset;
  fastMode?: boolean;
  slowMode?: boolean;
  advisorEnabled?: boolean;
}

export type ExecutionMode = "fallback" | "wait";

export interface ExecutionModel {
  provider: string;
  modelId: string;
}

export interface ExecutionPolicy {
  mode: ExecutionMode;
}

export type ExecutionJobStatus = "pending" | "waiting" | "running" | "completed" | "cancelled" | "failed" | "uncertain";

export interface ExecutionJob extends ExecutionModel, ExecutionPromptOptions {
  id: string;
  requestId?: string;
  imageCount?: number;
  btwId?: string;
  kind: "prompt" | "resume";
  status: ExecutionJobStatus;
  runAt: number | null;
  prompt: string;
  createdAt: number;
  updatedAt?: number;
  dismissedAt?: number;
  continuation?: boolean;
  error?: string;
}

export interface ExecutionSnapshot {
  policy: ExecutionPolicy;
  jobs: ExecutionJob[];
}
