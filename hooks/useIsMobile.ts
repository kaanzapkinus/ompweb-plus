"use client";

import { useSyncExternalStore } from "react";

// Mobile breakpoint shared with app/globals.css (max-width: 640px).
export const MOBILE_QUERY = "(max-width: 640px)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real viewport after hydration.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The same breakpoint as `useIsMobile`, readable outside render (effects,
 * event handlers) where the hook's server snapshot would still say desktop. */
export function matchMobileViewport(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

const COMPACT_QUERY = `${MOBILE_QUERY}, (max-height: 500px)`;

function subscribeCompact(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", cb);
  return () => query.removeEventListener("change", cb);
}

function compactSnapshot(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(COMPACT_QUERY).matches;
}

/** Keyboard-safe compact sheets also cover short landscape phone viewports. */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribeCompact, compactSnapshot, getServerSnapshot);
}
