import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { isAbsolute, resolve } from "path";
import { comparableProjectPath } from "./comparable-path";
import { getAgentDir } from "./omp/paths";
import { ProjectPathError, validateProjectPath } from "./project-registry";
import { readSessionHeader, resolveSessionPath } from "./session-reader";
import { resolveProject } from "./worktree";

import type { SessionFolder, SessionFoldersRegistry } from "./types";
export type { SessionFolder, SessionFoldersRegistry };

export class SessionFoldersError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "SessionFoldersError";
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim()
    && !/[/\\\u0000-\u001f\u007f]/.test(value)
    && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

function requireIdentifier(value: unknown, field: string): asserts value is string {
  if (!isIdentifier(value)) throw new SessionFoldersError(`Invalid ${field}`);
}

function requireName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SessionFoldersError("Folder name is required");
  }
}

function validateRegistry(value: unknown): asserts value is SessionFoldersRegistry {
  const invalid = () => { throw new SessionFoldersError("Invalid session folders registry", 500); };
  const registry = value as Partial<SessionFoldersRegistry> | null;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)
    || registry.version !== 1 || !Array.isArray(registry.folders)
    || !registry.assignments || typeof registry.assignments !== "object" || Array.isArray(registry.assignments)) {
    return invalid();
  }
  const folderIds = new Set<string>();
  for (const folder of registry.folders) {
    if (!folder || typeof folder !== "object" || Array.isArray(folder) || !isIdentifier(folder.id) || folderIds.has(folder.id)
      || typeof folder.name !== "string" || !folder.name.trim()
      || typeof folder.projectPath !== "string" || !isAbsolute(folder.projectPath) || folder.projectPath.includes("\0")
      || typeof folder.createdAt !== "string" || !Number.isFinite(Date.parse(folder.createdAt))
      || (folder.order !== undefined && (typeof folder.order !== "number" || !Number.isFinite(folder.order)))) {
      return invalid();
    }
    folderIds.add(folder.id);
  }
  for (const [sessionId, folderId] of Object.entries(registry.assignments)) {
    if (!isIdentifier(sessionId) || typeof folderId !== "string" || !folderIds.has(folderId)) return invalid();
  }
}

function getFoldersFilePath(): string {
  return resolve(getAgentDir(), "session-folders.json");
}

/** Only an absent file is empty. Never turn damaged or unreadable data into a
 * writable empty registry: the next mutation would erase the user's folders. */
export function loadSessionFoldersRegistry(): SessionFoldersRegistry {
  let raw: string;
  try {
    raw = readFileSync(getFoldersFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, folders: [], assignments: {} };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionFoldersError("Invalid session folders registry JSON", 500);
  }
  validateRegistry(parsed);
  return parsed;
}

/** Same-directory rename keeps the previous complete registry on write failure. */
export function saveSessionFoldersRegistry(registry: SessionFoldersRegistry): void {
  validateRegistry(registry);
  // Also guard direct callers against replacing an already corrupt file.
  loadSessionFoldersRegistry();
  const filePath = getFoldersFilePath();
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  const temp = `${filePath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, filePath);
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Cleanup must not hide the original persistence failure.
    }
  }
}

export async function createSessionFolder(name: string, projectPath: string): Promise<SessionFolder> {
  requireName(name);
  let normalized: string;
  try {
    normalized = validateProjectPath(projectPath);
  } catch (error) {
    if (error instanceof ProjectPathError) throw new SessionFoldersError(error.message);
    throw error;
  }
  const { projectRoot } = await resolveProject(normalized);
  // Keep load/mutate/save synchronous after identity resolution, so requests in
  // this process cannot interleave their registry snapshots across an await.
  const registry = loadSessionFoldersRegistry();
  const folder: SessionFolder = {
    id: `f-${randomUUID()}`,
    name: name.trim(),
    projectPath: comparableProjectPath(projectRoot),
    createdAt: new Date().toISOString(),
    order: registry.folders.length,
  };
  registry.folders.push(folder);
  saveSessionFoldersRegistry(registry);
  return folder;
}

export function renameSessionFolder(folderId: string, newName: string): boolean {
  requireIdentifier(folderId, "folderId");
  requireName(newName);
  const registry = loadSessionFoldersRegistry();
  const folder = registry.folders.find((f) => f.id === folderId);
  if (!folder) return false;
  folder.name = newName.trim();
  saveSessionFoldersRegistry(registry);
  return true;
}

export function deleteSessionFolder(folderId: string): boolean {
  requireIdentifier(folderId, "folderId");
  const registry = loadSessionFoldersRegistry();
  const index = registry.folders.findIndex((f) => f.id === folderId);
  if (index === -1) return false;
  registry.folders.splice(index, 1);
  // Folder membership is metadata only; native sessions and ancestry stay intact.
  for (const [sessionId, assignedFolderId] of Object.entries(registry.assignments)) {
    if (assignedFolderId === folderId) delete registry.assignments[sessionId];
  }
  saveSessionFoldersRegistry(registry);
  return true;
}

export async function assignSessionToFolder(sessionId: string, folderId: string | null): Promise<void> {
  requireIdentifier(sessionId, "sessionId");
  if (folderId !== null) requireIdentifier(folderId, "folderId");
  const filePath = await resolveSessionPath(sessionId);
  const header = filePath ? readSessionHeader(filePath) : null;
  if (!header || header.id !== sessionId) throw new SessionFoldersError("Session not found", 404);
  const { projectRoot } = await resolveProject(header.cwd);
  const initialRegistry = loadSessionFoldersRegistry();
  const initialFolder = folderId === null ? undefined : initialRegistry.folders.find((f) => f.id === folderId);
  if (folderId !== null && !initialFolder) throw new SessionFoldersError("Folder not found", 404);
  const folderProject = initialFolder ? await resolveProject(initialFolder.projectPath) : undefined;
  if (folderProject && comparableProjectPath(folderProject.projectRoot) !== comparableProjectPath(projectRoot)) {
    throw new SessionFoldersError("Session and folder must belong to the same project");
  }
  // Re-read after asynchronous project resolution to preserve concurrent edits.
  const registry = loadSessionFoldersRegistry();
  if (folderId === null) {
    delete registry.assignments[sessionId];
  } else {
    const folder = registry.folders.find((f) => f.id === folderId);
    if (!folder || folder.projectPath !== initialFolder?.projectPath) throw new SessionFoldersError("Folder not found", 404);
    registry.assignments[sessionId] = folderId;
  }
  saveSessionFoldersRegistry(registry);
}
