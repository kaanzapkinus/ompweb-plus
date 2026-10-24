import type { SessionInfo } from "@/lib/types";
import type { SessionTreeNode } from "./SessionSidebar-helpers";

/** Folders organize individual chats, never their native cwd or ancestry.
 * Split only presentation edges that cross groups; every chat appears once. */
export function groupSessionTreeByFolder(
  tree: SessionTreeNode[],
  folderIds: readonly string[],
  assignments: Record<string, string>,
) {
  const byFolder = new Map<string, SessionTreeNode[]>(folderIds.map((id) => [id, []]));
  const counts = new Map<string, number>(folderIds.map((id) => [id, 0]));
  const unassigned: SessionTreeNode[] = [];
  const separatedParents = new Map<string, SessionInfo>();
  const nativeParentPaths = new Set<string>();
  let unassignedCount = 0;
  const visit = (node: SessionTreeNode, parent?: SessionTreeNode, parentFolder?: string) => {
    if (node.children.length > 0) nativeParentPaths.add(node.session.path);
    const assigned = assignments[node.session.id];
    const folderId = byFolder.has(assigned) ? assigned : undefined;
    const copy: SessionTreeNode = { session: node.session, children: [] };
    if (parent && folderId === parentFolder) parent.children.push(copy);
    else {
      (folderId ? byFolder.get(folderId)! : unassigned).push(copy);
      if (parent) separatedParents.set(node.session.path, parent.session);
    }
    if (folderId) counts.set(folderId, counts.get(folderId)! + 1);
    else unassignedCount++;
    for (const child of node.children) visit(child, copy, folderId);
  };
  for (const root of tree) visit(root);
  const byModified = (a: SessionTreeNode, b: SessionTreeNode) => b.session.modified.localeCompare(a.session.modified);
  for (const group of byFolder.values()) group.sort(byModified);
  unassigned.sort(byModified);
  return { byFolder, unassigned, counts, unassignedCount, separatedParents, nativeParentPaths };
}

/** Bind at the leaf only, so a fork's menu can never move its root instead. */
export function bindSessionFolderActions(
  sessionId: string,
  assign?: (sessionId: string, folderId: string | null) => Promise<void>,
  createAndAssign?: (sessionId: string, name: string) => Promise<void>,
) {
  return {
    onAssignFolder: assign ? (folderId: string | null) => assign(sessionId, folderId) : undefined,
    onCreateFolderAndAssign: createAndAssign ? (name: string) => createAndAssign(sessionId, name) : undefined,
  };
}
