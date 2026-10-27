import type { SessionInfo } from "./types";

export interface ChatSearchResult {
  session: SessionInfo;
  excerpt: string;
  role: "user" | "assistant" | null;
  entryId?: string;
}

export interface SessionSearchResponse {
  results: ChatSearchResult[];
  total: number;
  hasMore: boolean;
  unavailable: number;
}

export interface RecentChatsResponse {
  sessions: (SessionInfo & { lastMessageAt: string })[];
  unavailable: number;
}
