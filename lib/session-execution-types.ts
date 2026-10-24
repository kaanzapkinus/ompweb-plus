export type ExecutionMode = "fallback" | "wait";

export interface ExecutionModel {
  provider: string;
  modelId: string;
}

export interface ExecutionPolicy {
  mode: ExecutionMode;
}

export type ExecutionJobStatus = "pending" | "waiting" | "running" | "completed" | "cancelled" | "failed" | "uncertain";

export interface ExecutionJob extends ExecutionModel {
  id: string;
  kind: "prompt" | "resume";
  status: ExecutionJobStatus;
  runAt: number | null;
  prompt: string;
  createdAt: number;
  error?: string;
}

export interface ExecutionSnapshot {
  policy: ExecutionPolicy;
  jobs: ExecutionJob[];
}
