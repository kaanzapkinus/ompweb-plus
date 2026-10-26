import type { SessionInfo, Workspace } from "./types";
import { comparableProjectPath } from "./comparable-path";

/** Assignment is presentation metadata. Never change native cwd or ancestry. */
export function groupWorkspaceSessions(workspaces: Workspace[], sessions: SessionInfo[], assignments: Record<string, string>) {
  const groups = workspaces.map(workspace => ({ workspace, sessions: [] as SessionInfo[] }));
  const byId = new Map(groups.map(group => [group.workspace.id, group]));
  for (const session of sessions) {
    const root = comparableProjectPath(session.projectRoot || session.cwd);
    const fallback = groups.find(group => group.workspace.id.startsWith("d-") && comparableProjectPath(group.workspace.cwd) === root)
      ?? groups.find(group => comparableProjectPath(group.workspace.cwd) === root);
    // A list invalidation can precede the registry response for a new runtime.
    // Keep it reachable until GET supplies its authoritative membership.
    const group = byId.get(assignments[session.id]) ?? fallback ?? groups[0];
    group?.sessions.push(session);
  }
  return groups;
}

export function workspaceCreationTarget(workspaces: Workspace[], workspaceId: string | null, executionCwd?: string | null) {
  const workspace = workspaces.find(workspace => workspace.id === workspaceId);
  return workspace ? { cwd: executionCwd ?? workspace.cwd, workspaceId: workspace.id } : null;
}

export function newWorkspaceDraftKey(cwd: string | null, workspaceId?: string | null): string | undefined {
  return cwd ? `new:${JSON.stringify([workspaceId ?? null, cwd])}` : undefined;
}
