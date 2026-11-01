import { useEffect, useRef } from "react";
import type { AnimationItem } from "lottie-web";
import { cn } from "@/lib/utils";

// Flexing-arm Lottie loader (assets/flex-arm.json, 2s loop). lottie-web's
// SVG-only "light" player and the animation are code-split and fetched on first
// mount, so neither weighs on the main bundle. Strokes follow `currentColor`
// (see .flex-loader in styles.css); set `--flex-stroke` to thicken them at
// small sizes. Pass `label` when the arm is the only loading cue on screen;
// without it the arm is decorative (aria-hidden).
export function FlexLoader({ className, label }: { className?: string; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let anim: AnimationItem | undefined;
    let cancelled = false;
    void Promise.all([
      import("lottie-web/build/player/lottie_light"),
      import("@/assets/flex-arm.json"),
    ]).then(([{ default: lottie }, { default: data }]) => {
      if (cancelled || !ref.current) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      anim = lottie.loadAnimation({
        container: ref.current,
        renderer: "svg",
        loop: true,
        autoplay: !reduceMotion,
        // lottie-web mutates animationData in place; each instance needs its own copy.
        animationData: structuredClone(data),
      });
      // Reduced motion: hold the peak-flex pose instead of looping.
      if (reduceMotion) anim.goToAndStop(26, true);
    });
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, []);

  return (
    <span
      ref={ref}
      className={cn("flex-loader inline-block size-8 shrink-0 text-primary", className)}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}
