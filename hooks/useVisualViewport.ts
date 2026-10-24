"use client";

import { useEffect, useState } from "react";

export interface VisualViewportState {
  /** Visible height in CSS px (keyboard-shrunk on iOS). */
  height: number;
  /** Offset of the visible viewport from the layout viewport top (px). */
  offsetTop: number;
  /** Offset of the visible viewport from the layout viewport left (px). */
  offsetLeft: number;
  /** Width of the visible viewport in CSS px. */
  width: number;
}

const FALLBACK: VisualViewportState = { height: 0, offsetTop: 0, offsetLeft: 0, width: 0 };

function readViewport(): VisualViewportState {
  if (typeof window === "undefined") return FALLBACK;
  const vv = window.visualViewport;
  if (!vv) return { height: window.innerHeight, offsetTop: 0, offsetLeft: 0, width: window.innerWidth };
  return { height: vv.height, offsetTop: vv.offsetTop, offsetLeft: vv.offsetLeft, width: vv.width };
}

/**
 * Live visual-viewport geometry, coalesced through requestAnimationFrame so a
 * burst of resize/scroll events (iOS keyboard) triggers at most one render per
 * frame. Also mirrors the values onto CSS custom properties on :root for the
 * stylesheet side of the contract.
 */
export function useVisualViewport(enabled = true): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(FALLBACK);

  useEffect(() => {
    if (!enabled) return;
    const apply = readViewport();
    setState(apply);
    writeCssVars(apply);

    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const next = readViewport();
        setState(next);
        writeCssVars(next);
      });
    };

    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return state;
}

function writeCssVars(state: VisualViewportState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--omp-vv-height", `${state.height}px`);
  root.style.setProperty("--omp-vv-offset-top", `${state.offsetTop}px`);
  root.style.setProperty("--omp-vv-offset-left", `${state.offsetLeft}px`);
  root.style.setProperty("--omp-vv-width", `${state.width}px`);
}
