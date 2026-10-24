/**
 * Optional terminal-quota fallback for errors the native retry engine gives up on.
 * OMP_AGY_FAILOVER_CHAIN is an ordered JSON array of provider/model selectors.
 * No configured chain means no model changes; see extensions/README.md.
 * Tried models are not repeated until a successful/non-quota turn resets them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Structural types keep this standalone extension independent of Bun-only packages.
type Model = { provider: string; id: string };
type Message = { role: string; stopReason?: string; errorMessage?: unknown };
type Context = {
  sessionManager: {
    getSessionId?: () => string;
    getBranch: () => Array<{ type: string; message?: Message }>;
  };
  models: {
    current: () => Model | undefined;
    resolve: (spec: string) => Model | undefined;
  };
};
type Continuation = { continue: true; additionalContext: string };
type ExtensionApi = {
  on: (name: "session_stop", handler: (event: unknown, ctx: Context) => Promise<Continuation | undefined>) => void;
  setModel: (model: Model) => Promise<boolean>;
};

const jobStatuses: Record<string, true> = {
  pending: true, waiting: true, running: true, completed: true,
  cancelled: true, failed: true, uncertain: true,
};

function validJob(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  return typeof job.id === "string"
    && typeof job.sessionId === "string"
    && typeof job.provider === "string"
    && typeof job.modelId === "string"
    && typeof job.prompt === "string"
    && Number.isFinite(job.createdAt)
    && (job.runAt === null || Number.isFinite(job.runAt))
    && typeof job.status === "string" && jobStatuses[job.status] === true
    && (job.kind === "prompt" || job.kind === "resume");
}

function fallbackAllowed(sessionId: string) {
  const dir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent");
  try {
    const store = JSON.parse(readFileSync(join(dir, "web-session-execution.json"), "utf8"));
    if (store.version !== 1 || !store.policies || typeof store.policies !== "object" || Array.isArray(store.policies) || !Array.isArray(store.jobs)) return false;
    if (Object.prototype.hasOwnProperty.call(store.policies, sessionId)) {
      const policy = store.policies[sessionId];
      if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.mode !== "fallback") return false;
    }
    if (!store.jobs.every(validJob)) return false;
    return !store.jobs.some((job: { sessionId?: unknown; status?: unknown }) => job.sessionId === sessionId && job.status === "running");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    // A corrupt/unreadable web policy is not permission to change the model.
    console.error("[agy-failover] execution policy unavailable; keeping selected model:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

const EXHAUST =
  /all accounts|all[ _]accounts?_(?:limited|exhausted|failed|unhealthy)|no accounts available|token pool is empty|账号池|网关调度|insufficient_user_quota|remaining eligible quota|RESOURCE_EXHAUSTED|quota exceeded|usage limit/i;

function configuredChain(): string[] {
  const value = process.env.OMP_AGY_FAILOVER_CHAIN;
  if (!value) return [];
  try {
    const chain: unknown = JSON.parse(value);
    if (!Array.isArray(chain) || !chain.every((spec): spec is string => typeof spec === "string" && /^[^/\s]+\/\S+$/.test(spec))) return [];
    return chain;
  } catch {
    // Invalid configuration must not silently select a different provider.
    return [];
  }
}

const triedBySession = new Map<string, Set<string>>();

export default function agyFailover(pi: ExtensionApi) {
  pi.on("session_stop", async (_event, ctx) => {
    const sm = ctx.sessionManager;
    const sid = sm.getSessionId ? sm.getSessionId() : "default";
    const branch = sm.getBranch();
    let msg;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry && entry.type === "message" && entry.message && entry.message.role === "assistant") {
        msg = entry.message;
        break;
      }
    }
    const text = msg && msg.errorMessage ? String(msg.errorMessage) : "";
    if (!msg || msg.stopReason !== "error" || !EXHAUST.test(text)) {
      triedBySession.delete(sid);
      return;
    }
    const chain = configuredChain();
    if (chain.length === 0) return;
    // Re-read at the terminal hook: a policy changed during this turn must win
    // over this extension's independent setModel/continue fallback mechanism.
    if (!fallbackAllowed(sid)) {
      triedBySession.delete(sid);
      return;
    }
    const cur = ctx.models.current();
    const curKey = cur ? `${cur.provider}/${cur.id}` : "";
    const tried = triedBySession.get(sid) || new Set();
    if (curKey) tried.add(curKey);
    for (const spec of chain) {
      if (tried.has(spec)) continue;
      const model = ctx.models.resolve(spec);
      if (!model) continue;
      const key = `${model.provider}/${model.id}`;
      if (tried.has(key)) continue;
      tried.add(key);
      triedBySession.set(sid, tried);
      try {
        if (!(await pi.setModel(model))) continue;
      } catch {
        continue;
      }
      return {
        continue: true,
        additionalContext:
          `[agy-failover] ${curKey} exhausted its available quota. ` +
          `Continue the same task with ${key}; do not repeat the quota error explanation.`,
      };
    }
    triedBySession.set(sid, tried);
    return;
  });
}
