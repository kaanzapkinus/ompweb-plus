export const VISIBLE_PAGE_SIZE = 50;

export function getVisibleRenderWindow(
  totalCount: number,
  visibleCount: number,
  anchor?: { startIndex: number; visibleCount: number },
): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const endAnchored = Math.max(0, totalCount - clampedVisibleCount);
  // Tail growth must not consume an explicit request for an earlier page.
  // The anchor is the old first row's position in the current transcript,
  // which can itself move when pre-compaction history is fetched.
  const addedVisibleCount = anchor ? Math.max(0, visibleCount - anchor.visibleCount) : 0;
  const startIndex = anchor
    ? Math.max(0, Math.min(totalCount, anchor.startIndex) - addedVisibleCount)
    : endAnchored;
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}
