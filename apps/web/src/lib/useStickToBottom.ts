import { useCallback, useEffect, useRef, useState } from "react";

// How close to the bottom (px) still counts as "pinned". A small slack keeps
// the follow-lock engaged through sub-pixel rounding and the last line of a
// growing stream, instead of detaching the moment content nudges past exact 0.
const BOTTOM_SLACK_PX = 64;

// How close to the top (px) fires `onReachTop` — used to lazily reveal older
// history before the user hits the exact top edge.
const TOP_SLACK_PX = 96;

// Tracks whether a scroll container is pinned to its bottom edge and exposes
// helpers to keep it there. The pattern: bind `ref` to the scroll element,
// call `followIfPinned()` whenever content grows (it scrolls down only when
// the user is already at the bottom, so reading older messages isn't yanked),
// and surface a "jump to bottom" affordance whenever `atBottom` is false.
export function useStickToBottom<T extends HTMLElement>(opts?: { onReachTop?: () => void }) {
  const ref = useRef<T | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Mirror in a ref so growth callbacks read the latest value synchronously
  // without re-subscribing on every change.
  const atBottomRef = useRef(true);
  // Latest-ref for the top callback so the scroll listener stays subscribed
  // once instead of re-binding whenever the caller passes a fresh closure.
  const onReachTopRef = useRef(opts?.onReachTop);
  onReachTopRef.current = opts?.onReachTop;

  const isAtBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
  }, []);

  const setPinned = useCallback((next: boolean) => {
    atBottomRef.current = next;
    setAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = ref.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
      setPinned(true);
    },
    [setPinned],
  );

  // Follow new content only while pinned. Uses a direct scrollTop write (not
  // smooth) so streaming deltas stay glued frame-to-frame without easing lag.
  const followIfPinned = useCallback(() => {
    if (!atBottomRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      setPinned(isAtBottom());
      if (el.scrollTop <= TOP_SLACK_PX) onReachTopRef.current?.();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Sync once in case the container mounted already scrolled.
    setPinned(isAtBottom());
    return () => el.removeEventListener("scroll", onScroll);
  }, [isAtBottom, setPinned]);

  return { ref, atBottom, scrollToBottom, followIfPinned };
}
