import { statSync, watch, type FSWatcher, type Stats } from "fs";
import { join } from "path";
import {
  getAgentDir,
  invalidateSessionEntriesCache,
  invalidateSessionListCache,
  invalidateSessionListMeta,
  listAllSessions,
  resolveSessionIdByPath,
} from "./session-reader";
import { listSessionFilesSync } from "./omp/session-files";

// omp owns the writes to a session's JSONL. ompweb streams RPC events only for
// the sessions it spawned itself, so a session started outside the web UI — by
// `omp` in a terminal, or by a harness that launches omp — never updated while
// it was open: the file grew and nothing told the browser. This watches the
// session tree and reports which session ids changed, which the running-events
// stream forwards to the client.

type Listener = (sessionIds: string[]) => void;

const DEBOUNCE_MS = 250;

const listeners = new Set<Listener>();
let watcher: FSWatcher | null = null;
let watcherRoot: string | null = null;
let watcherGeneration = 0;
let startupSnapshot: Map<string, Stats> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPaths = new Set<string>();
let pendingUnknown = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = 5000;
const STARTUP_POLL_MS = 1000;

function snapshotSessionFiles(sessionsDir: string): Map<string, Stats> {
  const snapshot = new Map<string, Stats>();
  for (const path of listSessionFilesSync(sessionsDir)) {
    try {
      const stat = statSync(path);
      if (stat.isFile()) snapshot.set(path, stat);
    } catch {
      // A session can disappear between the directory walk and stat.
    }
  }
  return snapshot;
}

function isCurrent(generation: number): boolean {
  if (generation !== watcherGeneration || listeners.size === 0) return false;
  if (watcherRoot !== join(getAgentDir(), "sessions")) {
    ensureWatcher();
    return false;
  }
  return true;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const generation = watcherGeneration;
  flushTimer = setTimeout(() => flush(generation), DEBOUNCE_MS);
}

function reconcileStartup(): void {
  if (!startupSnapshot || !watcherRoot) return;
  const next = snapshotSessionFiles(watcherRoot);
  for (const [path, stat] of next) {
    const previous = startupSnapshot.get(path);
    if (!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs
      || previous.ctimeMs !== stat.ctimeMs || previous.ino !== stat.ino) pendingPaths.add(path);
  }
  for (const path of startupSnapshot.keys()) {
    if (!next.has(path)) pendingPaths.add(path);
  }
  startupSnapshot = next;
  if (pendingPaths.size > 0) scheduleFlush();
}

function scheduleStartupCheck(): void {
  if (startupTimer || !startupSnapshot || listeners.size === 0) return;
  const generation = watcherGeneration;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (!isCurrent(generation)) return;
    reconcileStartup();
    scheduleStartupCheck();
  }, STARTUP_POLL_MS);
  startupTimer.unref?.();
}

function stopWatcher(): void {
  watcherGeneration++;
  clearTimeout(flushTimer ?? undefined);
  clearTimeout(retryTimer ?? undefined);
  clearTimeout(startupTimer ?? undefined);
  flushTimer = retryTimer = startupTimer = null;
  startupSnapshot = null;
  pendingPaths = new Set();
  pendingUnknown = false;
  watcher?.close();
  watcher = null;
  watcherRoot = null;
}

function flush(generation: number): void {
  if (!isCurrent(generation)) return;
  flushTimer = null;
  const paths = [...pendingPaths];
  pendingPaths = new Set();
  const hadUnknown = pendingUnknown;
  pendingUnknown = false;
  if (paths.length === 0 && !hadUnknown) return;

  if (hadUnknown) {
    // filename was null — fs.watch coalesced the event or overflowed. We
    // don't know which file changed, so fall back to the full invalidation.
    invalidateSessionListCache();
    void rescanAndNotify(generation);
    return;
  }

  // Known paths: refresh the list metadata (a changed file means the cached
  // list's mtimes and message counts are stale) and invalidate ONLY the
  // changed sessions' parse caches, leaving unrelated sessions cached.
  invalidateSessionListMeta();
  for (const path of paths) invalidateSessionEntriesCache(path);

  void Promise.all(paths.map((path) => resolveSessionIdByPath(path).catch(() => undefined)))
    .then((ids) => {
      if (!isCurrent(generation)) return;
      const sessionIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
      if (sessionIds.length === 0) return;
      for (const listener of listeners) {
        try {
          listener(sessionIds);
        } catch {
          // a failing subscriber must not stop the others
        }
      }
    })
    .catch(() => {
      // resolution failures are not worth tearing the watcher down for
    });
}

async function rescanAndNotify(generation: number): Promise<void> {
  try {
    const sessions = await listAllSessions();
    if (!isCurrent(generation)) return;
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length === 0) return;
    for (const listener of listeners) {
      try {
        listener(sessionIds);
      } catch {
        // a failing subscriber must not stop the others
      }
    }
  } catch {
    // resolution failures are not worth tearing the watcher down for
  }
}

function scheduleRetry(): void {
  if (retryTimer || listeners.size === 0) return;
  const generation = watcherGeneration;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (isCurrent(generation)) ensureWatcher();
  }, RETRY_MS);
}

function ensureWatcher(): void {
  const sessionsDir = join(getAgentDir(), "sessions");
  if (watcherRoot && watcherRoot !== sessionsDir) stopWatcher();
  if (watcher || retryTimer || listeners.size === 0) return;
  watcherRoot = sessionsDir;
  // fs.watch returns before macOS's FSEvents stream is armed and has no
  // ready event. Track metadata from before subscription returns until a
  // real event proves the current native handle is receiving changes.
  // The cached directory walk and stats never parse session transcripts.
  startupSnapshot ??= snapshotSessionFiles(sessionsDir);
  const generation = watcherGeneration;
  try {
    const currentWatcher = watch(sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
      if (!isCurrent(generation) || watcher !== currentWatcher) return;
      if (startupSnapshot) {
        reconcileStartup();
        startupSnapshot = null;
        clearTimeout(startupTimer ?? undefined);
        startupTimer = null;
      }
      if (!filename) {
        pendingUnknown = true;
        scheduleFlush();
        return;
      }
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      pendingPaths.add(join(sessionsDir, name));
      scheduleFlush();
    });
    watcher = currentWatcher;
    currentWatcher.on("error", () => {
      if (!isCurrent(generation) || watcher !== currentWatcher) return;
      currentWatcher.close();
      watcher = null;
      startupSnapshot ??= snapshotSessionFiles(sessionsDir);
      scheduleStartupCheck();
      scheduleRetry();
    });
  } catch {
    // No sessions directory yet, or the platform refused a recursive watch.
    // Schedule a retry while subscribers remain; otherwise degrade silently.
    watcher = null;
    scheduleRetry();
  }
  scheduleStartupCheck();
}

export function subscribeSessionFileChanges(listener: Listener): () => void {
  listeners.add(listener);
  ensureWatcher();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopWatcher();
  };
}
