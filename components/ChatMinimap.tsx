"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { AgentMessage, TextContent } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

export interface NavNode {
  id: string;
  text: string;
  messageIndex: number;
  refIndex: number;
  isUser: boolean;
}

/**
 * Extracts a concise, clean single-line preview string suitable for the
 * floating context navigation pill (e.g. "move Explorer to right panel").
 */
export function extractPreviewText(msg: AgentMessage | Partial<AgentMessage>): string {
  let raw = "";

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      raw = content;
    } else if (Array.isArray(content)) {
      raw = content
        .filter((b): b is TextContent => Boolean(b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string"))
        .map((b) => b.text)
        .join(" ");
    }
  } else if (msg.role === "assistant") {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((b): b is TextContent => Boolean(b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string"))
      .map((b) => b.text)
      .join(" ");
    if (text) {
      raw = text;
    } else {
      const toolNames = blocks
        .filter((b) => Boolean(b && typeof b === "object" && "type" in b && b.type === "toolCall"))
        .map((b) => (b && typeof b === "object" && "toolName" in b && typeof b.toolName === "string" ? b.toolName : ""));
      if (toolNames.length) raw = toolNames.filter(Boolean).join(", ");
    }
  }

  // Strip markdown headers, code blocks, formatting, and flatten whitespace
  let clean = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_`~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    clean = raw.replace(/\s+/g, " ").trim();
  }

  if (clean.length > 60) {
    return clean.slice(0, 58) + "…";
  }
  return clean;
}

/**
 * Calculates a dynamic bar width to create the natural, organic minimap rhythm
 * seen in chat outlines (shorter bars for brief turns, longer for detailed prompts).
 */
export function getBarWidth(text: string, isActive: boolean, isHovered: boolean): number {
  if (isActive) return 24;
  if (isHovered) return 22;
  const len = text.length;
  if (len <= 15) return 10;
  if (len <= 30) return 14;
  if (len <= 50) return 18;
  return 20;
}

const ROW_HEIGHT = 18;
const RAIL_PADDING = 6;
const MAX_RAIL_HEIGHT = 520;

export const ChatMinimap = memo(function ChatMinimap({ messages, scrollContainer, messageRefs }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isRailHovered, setIsRailHovered] = useState(false);
  const [conversationHeight, setConversationHeight] = useState(0);
  const [railScrollTop, setRailScrollTop] = useState(0);
  const [tooltipHeight, setTooltipHeight] = useState(0);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  // Extract navigation nodes: user prompts first (as the chapters of context),
  // falling back to assistant messages if no user prompts exist yet.
  const nodes = useMemo(() => {
    const userNodes: NavNode[] = [];
    let refIndex = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const currentRef = refIndex++;
      if (msg.role === "user") {
        const text = extractPreviewText(msg);
        if (text) {
          const id = msg && typeof msg === "object" && "id" in msg && typeof msg.id === "string" ? msg.id : `u-${i}`;
          userNodes.push({
            id,
            text,
            messageIndex: i,
            refIndex: currentRef,
            isUser: true,
          });
        }
      }
    }

    if (userNodes.length > 0) return userNodes;

    // Fallback: assistant messages
    const assistantNodes: NavNode[] = [];
    let aRef = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const currentRef = aRef++;
      if (msg.role === "assistant") {
        const text = extractPreviewText(msg);
        if (text) {
          const id = msg && typeof msg === "object" && "id" in msg && typeof msg.id === "string" ? msg.id : `a-${i}`;
          assistantNodes.push({
            id,
            text,
            messageIndex: i,
            refIndex: currentRef,
            isUser: false,
          });
        }
      }
    }
    return assistantNodes;
  }, [messages]);

  const railHeight = Math.min(conversationHeight, MAX_RAIL_HEIGHT, nodes.length * ROW_HEIGHT + RAIL_PADDING * 2);

  // Smoothly scroll to the target message with multi-strategy element resolution
  const reducedMotion = usePrefersReducedMotion();
  const scrollToNode = useCallback((node: NavNode, smooth = true) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    let targetEl = messageRefs.current?.[node.refIndex];
    if (!targetEl) {
      targetEl = scrollEl.querySelector(`[data-message-index="${node.messageIndex}"]`) as HTMLDivElement | null;
    }
    if (!targetEl && node.text) {
      const cards = scrollEl.querySelectorAll(".chat-message-card");
      const sample = node.text.slice(0, 20);
      for (const card of Array.from(cards)) {
        if (card.textContent?.includes(sample)) {
          targetEl = (card.closest("[data-message-index]") || card.parentElement || card) as HTMLDivElement;
          break;
        }
      }
    }

    const behavior: ScrollBehavior = smooth && !reducedMotion ? "smooth" : "auto";
    if (targetEl) {
      const containerRect = scrollEl.getBoundingClientRect();
      const elRect = targetEl.getBoundingClientRect();
      const targetScroll = Math.max(0, scrollEl.scrollTop + (elRect.top - containerRect.top) - 16);
      scrollEl.scrollTo({ top: targetScroll, behavior });
    } else {
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (maxScroll > 0) {
        const targetScroll = Math.max(0, (node.messageIndex / Math.max(1, messages.length - 1)) * maxScroll);
        scrollEl.scrollTo({ top: targetScroll, behavior });
      }
    }
  }, [scrollContainer, messageRefs, messages.length, reducedMotion]);

  const scrollToNodeRef = useRef(scrollToNode);
  scrollToNodeRef.current = scrollToNode;

  // Scroll-spy: identify which message node is currently in the viewport
  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl || nodes.length === 0) return;

    const { scrollTop, clientHeight, scrollHeight } = scrollEl;

    // Bottom reached -> last node active
    if (scrollTop + clientHeight >= scrollHeight - 30) {
      setActiveIndex(nodes.length - 1);
      return;
    }

    const containerRect = scrollEl.getBoundingClientRect();
    let bestIdx = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let el = messageRefs.current?.[node.refIndex];
      if (!el) {
        el = scrollEl.querySelector(`[data-message-index="${node.messageIndex}"]`) as HTMLDivElement | null;
      }
      if (!el) continue;
      const elRect = el.getBoundingClientRect();
      const relTop = elRect.top - containerRect.top;
      if (relTop <= 120) {
        bestIdx = i;
      } else {
        break;
      }
    }

    setActiveIndex(bestIdx);
  }, [scrollContainer, messageRefs, nodes]);

  const updateScrollRef = useRef(updateScroll);
  updateScrollRef.current = updateScroll;

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const handleScroll = () => {
      if (scrollRafRef.current === null) {
        scrollRafRef.current = requestAnimationFrame(() => {
          scrollRafRef.current = null;
          updateScrollRef.current();
        });
      }
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [scrollContainer]);

  // The message viewport, not the browser viewport, owns the space left after
  // metrics, scheduling controls and the composer have taken their actual height.
  useLayoutEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const updateSize = () => {
      setConversationHeight(el.clientHeight);
      updateScrollRef.current();
    };
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    updateSize();
    return () => ro.disconnect();
  }, [scrollContainer]);

  // Scroll only the rail: scrollIntoView can also move the conversation's
  // ancestors. Even a small node count can overflow a short message viewport.
  useEffect(() => {
    const rail = railRef.current;
    const row = rail?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!rail || !row || rail.clientHeight === 0 || draggingRef.current) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const target = top < rail.scrollTop
      ? top
      : bottom > rail.scrollTop + rail.clientHeight
        ? bottom - rail.clientHeight
        : null;
    if (target !== null) rail.scrollTo({ top: target, behavior: reducedMotion ? "auto" : "smooth" });
  }, [activeIndex, nodes.length, railHeight, reducedMotion]);

  // Drag scrubber interaction along the vertical rail
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (nodes.length === 0 || e.button !== 0) return;
    e.preventDefault();
    dragCleanupRef.current?.();
    draggingRef.current = true;

    const handlePointerY = (clientY: number) => {
      const railEl = railRef.current;
      if (!railEl) return;
      const rect = railEl.getBoundingClientRect();
      if (railEl.clientHeight === 0 || rect.height === 0) return;
      const scale = rect.height / railEl.clientHeight;
      const rowY = (clientY - rect.top) / scale + railEl.scrollTop - RAIL_PADDING;
      const targetIdx = Math.max(0, Math.min(nodes.length - 1, Math.floor(rowY / ROW_HEIGHT)));
      if (nodes[targetIdx]) {
        scrollToNodeRef.current(nodes[targetIdx], false);
        setActiveIndex(targetIdx);
        setHoveredIndex(targetIdx);
      }
    };

    handlePointerY(e.clientY);

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      handlePointerY(ev.clientY);
    };

    const onUp = () => {
      draggingRef.current = false;
      setHoveredIndex(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = onUp;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [nodes]);

  // Interrupted drag cleanup on unmount
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // Keep the preview aligned to the visible row, then constrain its complete
  // measured box to the same conversation bounds as the rail.
  const displayTooltipIndex = hoveredIndex !== null ? hoveredIndex : (isRailHovered ? activeIndex : null);
  const tooltipNode = displayTooltipIndex !== null ? nodes[displayTooltipIndex] : null;
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const updateHeight = () => setTooltipHeight(tooltip.offsetHeight);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(tooltip);
    updateHeight();
    return () => observer.disconnect();
  }, [tooltipNode]);
  const tooltipCenter = displayTooltipIndex !== null
    ? RAIL_PADDING + displayTooltipIndex * ROW_HEIGHT + ROW_HEIGHT / 2 - railScrollTop
    : 0;
  const tooltipHalfHeight = Math.min(tooltipHeight, railHeight) / 2;
  const tooltipTopPx = Math.max(tooltipHalfHeight, Math.min(railHeight - tooltipHalfHeight, tooltipCenter));

  if (nodes.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        pointerEvents: "auto",
        userSelect: "none",
        height: railHeight,
        maxHeight: "100%",
        overflow: railHeight === 0 ? "hidden" : undefined,
        marginRight: 8,
      }}
    >
      {/* The outer container leaves horizontal room for the bounded preview. */}
      {tooltipNode && (
        <div
          ref={tooltipRef}
          role="tooltip"
          onClick={(e) => {
            e.stopPropagation();
            scrollToNode(tooltipNode);
          }}
          style={{
            position: "absolute",
            right: "calc(100% + 10px)",
            top: tooltipTopPx,
            transform: "translateY(-50%)",
            whiteSpace: "nowrap",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            padding: "6px 14px",
            boxShadow: "var(--shadow-pop)",
            color: "var(--text)",
            fontSize: 12,
            fontWeight: 500,
            lineHeight: 1.4,
            pointerEvents: "auto",
            zIndex: 60,
            boxSizing: "border-box",
            maxHeight: "100%",
            maxWidth: 280,
            overflow: "hidden",
            textOverflow: "ellipsis",
            cursor: "pointer",
          }}
        >
          {tooltipNode.text}
        </div>
      )}

      {/* The Rail Container */}
      <div
        ref={railRef}
        role="navigation"
        aria-label="Chat context navigation"
        onMouseEnter={() => setIsRailHovered(true)}
        onMouseLeave={() => {
          setIsRailHovered(false);
          setHoveredIndex(null);
        }}
        onMouseDown={handleMouseDown}
        onScroll={(e) => setRailScrollTop(e.currentTarget.scrollTop)}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          boxSizing: "border-box",
          padding: `${RAIL_PADDING}px 6px ${RAIL_PADDING}px 8px`,
          height: "100%",
          minHeight: 0,
          overflowY: "auto",
          scrollbarWidth: "none",
          cursor: "pointer",
        }}
      >
        {/* Subtle vertical hairline anchor on the left */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 8,
            top: 4,
            bottom: 4,
            width: 1,
            background: "color-mix(in srgb, var(--border) 60%, transparent)",
            borderRadius: 1,
            pointerEvents: "none",
          }}
        />

        {/* Navigation bars */}
        {nodes.map((node, i) => {
          const isActive = activeIndex === i;
          const isHovered = hoveredIndex === i;

          return (
            <div
              key={node.id}
              data-index={i}
              role="button"
              tabIndex={0}
              aria-label={`Jump to: ${node.text}`}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex((cur) => (cur === i ? null : cur))}
              onFocus={() => setHoveredIndex(i)}
              onBlur={() => setHoveredIndex((cur) => (cur === i ? null : cur))}
              onClick={(e) => {
                e.stopPropagation();
                scrollToNode(node);
                setActiveIndex(i);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  scrollToNode(node);
                  setActiveIndex(i);
                }
              }}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                height: ROW_HEIGHT,
                flexShrink: 0,
                paddingLeft: 6,
                paddingRight: 8,
                cursor: "pointer",
              }}
            >
              {/* The Horizontal Pill Bar */}
              <div
                style={{
                  width: getBarWidth(node.text, isActive, isHovered),
                  height: isActive ? 4 : 3,
                  borderRadius: 9999,
                  background: isActive
                    ? "var(--text)"
                    : isHovered
                    ? "color-mix(in srgb, var(--text) 85%, transparent)"
                    : "color-mix(in srgb, var(--text-dim) 40%, transparent)",
                  boxShadow: isActive
                    ? "0 0 6px color-mix(in srgb, var(--text) 30%, transparent)"
                    : "none",
                  transition: "all 160ms var(--ease-out-warm)",
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const prevCount = useRef(0);
  if (prevCount.current !== count) {
    prevCount.current = count;
    refs.current = refs.current.slice(0, count);
  }
  return refs;
}
