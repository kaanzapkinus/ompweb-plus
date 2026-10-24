"use client";

/**
 * Warm-paper UI primitives on top of @base-ui/react.
 * Theming contract: CSS variables from globals.css (--bg, --accent, --radius-*,
 * --shadow-*, --dur-*, --ease-out-warm). No hardcoded colors here.
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import type React from "react";
import { useVisualViewport } from "@/hooks/useVisualViewport";

/* ---------------------------------- Dialog --------------------------------- */

export function Dialog({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </BaseDialog.Root>
  );
}

export function DialogContent({ children, className, style, ariaLabel, viewportBound = false, finalFocus }: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  /** Let the caller's CSS bound the popup to the keyboard-visible viewport. */
  viewportBound?: boolean;
  finalFocus?: React.ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
}) {
  useVisualViewport(viewportBound);
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        style={{
          position: "fixed", inset: 0,
          background: "var(--overlay-backdrop)",
          backdropFilter: "blur(2px)",
          zIndex: 1000,
        }}
      />
      <BaseDialog.Popup
        aria-label={ariaLabel}
        className={className}
        finalFocus={finalFocus}
        style={{
          position: "fixed",
          zIndex: 1001,
          boxShadow: "var(--shadow-modal)",
          // Opt-in dialogs own their geometry, scrolling and padding in CSS.
          // The default inline styles otherwise override a caller's class.
          ...(!viewportBound ? {
            top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            // The animation must retain the centering transform.
            animation: "dialog-pop-in var(--dur-med) var(--ease-out-warm) both",
            background: "var(--bg)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-modal)",
            padding: 20,
            maxWidth: "min(92vw, 560px)",
            maxHeight: "calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
            overflow: "auto",
          } : {}),
          ...style,
        }}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <BaseDialog.Title className="display-serif" style={{ fontSize: 20, margin: "0 0 12px", ...style }}>
      {children}
    </BaseDialog.Title>
  );
}

export const DialogClose = BaseDialog.Close;

/* ---------------------------------- Tooltip -------------------------------- */

export function Tooltip({ content, children, side = "top" }: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <BaseTooltip.Provider delay={350} closeDelay={0}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner side={side} sideOffset={6} style={{ zIndex: 1100 }}>
            <BaseTooltip.Popup
              style={{
                background: "var(--bg-panel)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                boxShadow: "var(--shadow-pop)",
                padding: "4px 9px",
                fontSize: 12,
                lineHeight: 1.4,
                maxWidth: 260,
              }}
            >
              {content}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}

/* -------------------------------- Collapsible ------------------------------- */

export function Collapsible({ open, onOpenChange, defaultOpen, children }: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <BaseCollapsible.Root open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen}>
      {children}
    </BaseCollapsible.Root>
  );
}

export const CollapsibleTrigger = BaseCollapsible.Trigger;

/** Phone sheet bounded by the visual viewport, including the open keyboard. */
export function SheetContent({ children, variant = "full", className, ariaLabel }: {
  children: React.ReactNode;
  variant?: "full" | "bottom";
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "var(--overlay-backdrop)", backdropFilter: "blur(2px)",
      }} />
      <BaseDialog.Popup
        aria-label={ariaLabel}
        className={`omp-sheet ${className ?? ""}`}
        style={{
          position: "fixed", left: 0, right: 0, zIndex: 1001,
          top: variant === "full" ? "var(--omp-vv-offset-top, 0px)" : undefined,
          bottom: variant === "bottom" ? "var(--omp-vv-keyboard-height, 0px)" : undefined,
          height: variant === "full" ? "var(--omp-vv-height, 100dvh)" : undefined,
          maxHeight: "var(--omp-vv-height, 100dvh)", maxWidth: "100vw",
          background: "var(--bg)", color: "var(--text)",
          border: "1px solid var(--border)", boxShadow: "var(--shadow-modal)",
          overflow: "hidden", display: "flex", flexDirection: "column",
        }}
      >
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}
