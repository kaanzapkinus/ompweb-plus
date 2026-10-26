import { createHash, randomUUID } from "crypto";
import { execFile } from "child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, resolve } from "path";
import { promisify } from "util";
import { comparableProjectPath } from "./comparable-path";
import { getAgentDir } from "./omp/paths";
import { loadProjectRegistry, ProjectPathError, validateProjectPath } from "./project-registry";
import { createChildProcessEnvironment } from "./project-command-env";
import { listAllSessions, readSessionHeader, resolveSessionPath } from "./session-reader";
import { listWorktrees, resolveProject } from "./worktree";
import type { SessionInfo, Workspace, WorkspacesRegistry } from "./types";
export type { Workspace, WorkspacesRegistry } from "./types";

const execFileAsync = promisify(execFile);

export class WorkspacesError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "WorkspacesError"; }
}
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim()
    && !/[/\\\u0000-\u001f\u007f]/.test(value)
    && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}
function requireIdentifier(value: unknown, field: string): asserts value is string {
  if (!isIdentifier(value)) throw new WorkspacesError(`Invalid ${field}`);
}
function requireName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new WorkspacesError("Workspace name is required");
}
function validPath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}
function validateRegistry(value: unknown): asserts value is WorkspacesRegistry {
  const invalid = () => { throw new WorkspacesError("Invalid workspaces registry; restore or repair workspaces.json before making changes", 500); };
  const registry = value as Partial<WorkspacesRegistry> | null;
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || registry.version !== 1 || !Array.isArray(registry.workspaces)
    || !registry.assignments || typeof registry.assignments !== "object" || Array.isArray(registry.assignments)) return invalid();
  const ids = new Set<string>();
  for (const workspace of registry.workspaces) {
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace) || !isIdentifier(workspace.id) || ids.has(workspace.id)
      || typeof workspace.name !== "string" || !workspace.name.trim() || !validPath(workspace.cwd)
      || typeof workspace.createdAt !== "string" || !Number.isFinite(Date.parse(workspace.createdAt))
      || typeof workspace.order !== "number" || !Number.isFinite(workspace.order)) return invalid();
    ids.add(workspace.id);
  }
  for (const [sessionId, workspaceId] of Object.entries(registry.assignments)) {
    if (!isIdentifier(sessionId) || !ids.has(workspaceId)) return invalid();
  }
}
function readJson(file: string): unknown | undefined {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return JSON.parse(raw); }
  catch { throw new WorkspacesError(`Invalid ${basename(file)} JSON; restore or repair it before making changes`, 500); }
}
const filePath = () => resolve(getAgentDir(), "workspaces.json");
function readPersisted(): WorkspacesRegistry | undefined {
  const value = readJson(filePath());
  if (value !== undefined) validateRegistry(value);
  return value as WorkspacesRegistry | undefined;
}
/** Atomic replacement; damaged existing storage can never become a writable empty registry. */
export function saveWorkspacesRegistry(registry: WorkspacesRegistry): void {
  validateRegistry(registry);
  if (!readPersisted()) readLegacy();
  const file = filePath(), temp = `${file}.tmp-${randomUUID()}`;
  mkdirSync(resolve(file, ".."), { recursive: true });
  try {
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* Preserve the original persistence failure. */ }
  }
}
function canonicalCwd(cwd: string): string {
  try { return realpathSync.native(validateProjectPath(cwd)); }
  catch (error) {
    if (error instanceof ProjectPathError) throw new WorkspacesError(error.message);
    throw error;
  }
}
function existingCwd(cwd: string): string | undefined {
  try { return canonicalCwd(cwd); }
  catch (error) { if (error instanceof WorkspacesError) return undefined; throw error; }
}
function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
interface LegacyFolder { id: string; name: string; projectPath: string; createdAt: string; order?: number }
interface LegacyRegistry { version: 1; folders: LegacyFolder[]; assignments: Record<string, string> }
function readLegacy(): LegacyRegistry | undefined {
  const value = readJson(resolve(getAgentDir(), "session-folders.json")) as LegacyRegistry | undefined;
  if (value === undefined) return undefined;
  // Reuse strict workspace validation, retaining the old optional ordering contract.
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.folders)) {
    throw new WorkspacesError("Invalid legacy session folders registry", 500);
  }
  validateRegistry({ version: value.version, workspaces: value.folders.map((folder, index) => folder && ({
    id: folder.id, name: folder.name, cwd: folder.projectPath, createdAt: folder.createdAt, order: folder.order ?? index,
  })), assignments: value.assignments });
  return value;
}
function migrateLegacy(legacy: LegacyRegistry | undefined, sessions: SessionInfo[]): WorkspacesRegistry {
  const registry: WorkspacesRegistry = { version: 1, workspaces: [], assignments: {} };
  if (!legacy) return registry;
  const byName = new Map<string, LegacyFolder[]>(), workspaceByFolder = new Map<string, string>();
  for (const folder of [...legacy.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const key = folder.name.trim().toLowerCase();
    const group = byName.get(key) ?? []; group.push(folder); byName.set(key, group);
    workspaceByFolder.set(folder.id, stableId("w", key));
  }
  for (const [sessionId, folderId] of Object.entries(legacy.assignments)) registry.assignments[sessionId] = workspaceByFolder.get(folderId)!;
  // Legacy folder rendering inherited the nearest explicitly assigned ancestor.
  // Materialize that effective membership now, including forks identified by path or ID.
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const session of sessions) {
    let current: SessionInfo | undefined = session;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const assigned = registry.assignments[current.id];
      if (assigned) { registry.assignments[session.id] = assigned; break; }
      current = current.parentSessionId ? byId.get(current.parentSessionId) : undefined;
    }
  }
  const projectCwds = loadProjectRegistry().projects.filter(project => !project.hidden).map(project => project.path);
  for (const [key, folders] of byName) {
    const id = stableId("w", key);
    const candidates = [...folders.map(folder => folder.projectPath), ...sessions.filter(session => registry.assignments[session.id] === id).map(session => session.cwd), ...projectCwds, homedir()];
    let cwd: string | undefined;
    for (const candidate of candidates) { cwd = existingCwd(candidate); if (cwd) break; }
    if (!cwd) throw new WorkspacesError("No existing directory is available for legacy workspace migration", 500);
    registry.workspaces.push({ id, name: folders[0].name.trim(), cwd, createdAt: folders[0].createdAt, order: registry.workspaces.length });
  }
  return registry;
}
function fillDirectoryDefaults(registry: WorkspacesRegistry, sessions: SessionInfo[]): boolean {
  let changed = false;
  const projects = loadProjectRegistry().projects;
  const byId = new Map(registry.workspaces.map(workspace => [workspace.id, workspace]));
  function ensure(cwd: string, createdAt: string, name?: string): string {
    // A missing historic cwd must remain selectable for viewing its conversations;
    // native creation separately requires an existing directory.
    const canonical = existingCwd(cwd) ?? resolve(cwd);
    const id = stableId("d", comparableProjectPath(canonical));
    if (!byId.has(id)) {
      const workspace = { id, name: name || basename(canonical) || canonical, cwd: canonical,
        createdAt: Number.isFinite(Date.parse(createdAt)) ? createdAt : new Date(0).toISOString(),
        order: Math.max(-1, ...registry.workspaces.map(item => item.order)) + 1 };
      registry.workspaces.push(workspace); byId.set(id, workspace); changed = true;
    }
    return id;
  }
  for (const session of sessions) {
    if (registry.assignments[session.id]) continue;
    const cwd = session.projectRoot || session.cwd;
    const project = projects.find(item => comparableProjectPath(item.path) === comparableProjectPath(cwd));
    registry.assignments[session.id] = ensure(cwd, session.created, project?.alias); changed = true;
  }
  const assigned = new Set(Object.values(registry.assignments));
  const retained = registry.workspaces.filter(workspace => !workspace.id.startsWith("d-") || assigned.has(workspace.id));
  if (retained.length !== registry.workspaces.length) { registry.workspaces = retained; changed = true; }
  return changed;
}
/** Read-only transcript discovery; only workspaces.json is ever written. */
export async function loadWorkspacesRegistry(): Promise<WorkspacesRegistry> {
  // Fail closed before discovery, and re-read after its await so concurrent edits survive.
  readPersisted();
  const sessions = await listAllSessions();
  let registry = readPersisted();
  const initial = !registry;
  registry ??= migrateLegacy(readLegacy(), sessions);
  const changed = fillDirectoryDefaults(registry, sessions);
  if (initial || changed) saveWorkspacesRegistry(registry);
  return registry;
}
export async function createWorkspace(name: string, cwd: string): Promise<Workspace> {
  requireName(name);
  const canonical = canonicalCwd(cwd);
  await loadWorkspacesRegistry();
  const registry = readPersisted()!;
  const workspace = { id: `w-${randomUUID()}`, name: name.trim(), cwd: canonical, createdAt: new Date().toISOString(), order: Math.max(-1, ...registry.workspaces.map(item => item.order)) + 1 };
  registry.workspaces.push(workspace); saveWorkspacesRegistry(registry); return workspace;
}
export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  requireIdentifier(workspaceId, "workspaceId"); requireName(name);
  await loadWorkspacesRegistry();
  const registry = readPersisted()!, workspace = registry.workspaces.find(item => item.id === workspaceId);
  if (!workspace) throw new WorkspacesError("Workspace not found", 404);
  workspace.name = name.trim(); saveWorkspacesRegistry(registry);
}
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  requireIdentifier(workspaceId, "workspaceId");
  await loadWorkspacesRegistry();
  const registry = readPersisted()!;
  if (!registry.workspaces.some(item => item.id === workspaceId)) throw new WorkspacesError("Workspace not found", 404);
  registry.workspaces = registry.workspaces.filter(item => item.id !== workspaceId);
  for (const [sessionId, id] of Object.entries(registry.assignments)) if (id === workspaceId) delete registry.assignments[sessionId];
  saveWorkspacesRegistry(registry);
}
export async function assignSessionToWorkspace(sessionId: string, workspaceId: string | null): Promise<void> {
  requireIdentifier(sessionId, "sessionId");
  if (workspaceId !== null) requireIdentifier(workspaceId, "workspaceId");
  const path = await resolveSessionPath(sessionId), header = path ? readSessionHeader(path) : null;
  if (!header || header.id !== sessionId) throw new WorkspacesError("Session not found", 404);
  await loadWorkspacesRegistry();
  const registry = readPersisted()!;
  if (workspaceId === null) delete registry.assignments[sessionId];
  else {
    if (!registry.workspaces.some(item => item.id === workspaceId)) throw new WorkspacesError("Workspace not found", 404);
    registry.assignments[sessionId] = workspaceId;
  }
  saveWorkspacesRegistry(registry);
}
/** Validate new-chat selection without ever changing an existing conversation cwd. */
export async function workspaceCreationCwd(cwd: string, workspaceId?: string): Promise<string> {
  if (workspaceId === undefined) return cwd;
  requireIdentifier(workspaceId, "workspaceId");
  const registry = await loadWorkspacesRegistry(), workspace = registry.workspaces.find(item => item.id === workspaceId);
  if (!workspace) throw new WorkspacesError("Workspace not found", 404);
  const selectedCwd = canonicalCwd(workspace.cwd), requestedCwd = canonicalCwd(cwd);
  if (requestedCwd === selectedCwd) return selectedCwd;
  const selectedProject = await resolveProject(selectedCwd);
  try {
    // Probe the candidate freshly: cached project identity intentionally infers
    // removed worktrees for browsing, and is not authority for native creation.
    const { stdout } = await execFileAsync("git", ["-C", requestedCwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"], {
      timeout: 10_000, maxBuffer: 1024 * 1024, env: createChildProcessEnvironment({ LC_ALL: "C" }),
    });
    const [commonDir, , toplevel] = stdout.trim().split("\n").map(path => canonicalCwd(path.trim()));
    if (comparableProjectPath(toplevel) === comparableProjectPath(requestedCwd)
      && comparableProjectPath(dirname(commonDir)) === comparableProjectPath(selectedProject.projectRoot)) {
      const worktrees = await listWorktrees(selectedCwd);
      if (worktrees.some(worktree => comparableProjectPath(existingCwd(worktree.path) ?? "") === comparableProjectPath(requestedCwd))) return requestedCwd;
    }
  } catch {
    // A failed Git probe cannot authorize a directory override.
  }
  throw new WorkspacesError("cwd does not match the selected workspace or one of its linked Git worktrees");
}
/** Native ownership moves keep metadata on the continued real identity, not on an obsolete ID. */
export function moveSessionWorkspace(oldId: string, newId: string): void {
  requireIdentifier(oldId, "sessionId"); requireIdentifier(newId, "sessionId");
  const registry = readPersisted();
  if (!registry || oldId === newId || !registry.assignments[oldId]) return;
  registry.assignments[newId] = registry.assignments[oldId]; delete registry.assignments[oldId];
  saveWorkspacesRegistry(registry);
}
/** Forks inherit the logical workspace, not merely their execution directory. */
export async function inheritSessionWorkspace(parentId: string, childId: string): Promise<void> {
  const registry = await loadWorkspacesRegistry();
  const workspaceId = registry.assignments[parentId];
  if (workspaceId) await assignSessionToWorkspace(childId, workspaceId);
}
