import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Foreground step detector for the PWA, built on the DeviceMotion API.
 *
 * Reality check (why this is the shape it is):
 *   - Browsers expose no pedometer. The only signal available is the
 *     accelerometer via `devicemotion`, so we run our own peak detector over
 *     it. There is no background access — sensors only fire while the page is
 *     in the foreground with the screen on, so this counts steps for an
 *     *active walk you start*, not an all-day background tally.
 *   - iOS 13+ gates motion behind a permission prompt that MUST be triggered
 *     from a user gesture (`DeviceMotionEvent.requestPermission()`), and only
 *     in a secure context (HTTPS / localhost). `start()` is therefore meant to
 *     be called straight from a click handler.
 *
 * The detector only reports `steps` accumulated since the current `start()`.
 * Persisting/merging with the server total is the caller's job — keeping this
 * hook a pure sensor + counting primitive.
 */

export type StepPermission = "unsupported" | "prompt" | "granted" | "denied";

// Peak-detection constants. The accelerometer magnitude includes gravity, so
// we EMA-track gravity and look at the dynamic (gravity-removed) component.
// A walking foot-strike shows up as a peak of ~1–2 m/s² on top of gravity.
const GRAVITY_EMA_ALPHA = 0.8; // higher = slower gravity tracking (more smoothing)
const STEP_THRESHOLD = 1.1; // m/s² dynamic accel to arm a step
const STEP_RELEASE = 0.5; // hysteresis: must fall below threshold*this to re-arm
const MIN_STEP_INTERVAL_MS = 250; // debounce: ≤ ~4 steps/sec (fast walk/jog)

type DeviceMotionEventCtor = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

function detectSupport(): { supported: boolean; needsPermission: boolean } {
  if (typeof window === "undefined" || typeof DeviceMotionEvent === "undefined") {
    return { supported: false, needsPermission: false };
  }
  const ctor = DeviceMotionEvent as DeviceMotionEventCtor;
  return {
    supported: true,
    needsPermission: typeof ctor.requestPermission === "function",
  };
}

export type StepDetector = {
  /** The device exposes a motion sensor we can listen to at all. */
  supported: boolean;
  /** Current motion-permission state (iOS gates this; elsewhere it's implicit). */
  permission: StepPermission;
  /** A listener is attached and we're actively counting. */
  tracking: boolean;
  /** Steps counted since the last `start()`. */
  steps: number;
  /** Begin tracking — requests permission first if the platform requires it. */
  start: () => Promise<void>;
  /** Stop tracking (detaches the listener). Keeps the current `steps` value. */
  stop: () => void;
  /** Reset the session step count to 0 (does not stop tracking). */
  reset: () => void;
  /** Non-fatal error surfaced from permission/listener setup, if any. */
  error: string | null;
};

export function useStepDetector(): StepDetector {
  const [{ supported, needsPermission }] = useState(detectSupport);
  const [permission, setPermission] = useState<StepPermission>(
    supported ? (needsPermission ? "prompt" : "granted") : "unsupported",
  );
  const [tracking, setTracking] = useState(false);
  const [steps, setSteps] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Detector state lives in refs so the high-frequency motion handler never
  // re-subscribes or re-renders on every sample.
  const gravityRef = useRef(9.81);
  const armedRef = useRef(false);
  const lastStepAtRef = useRef(0);

  const handleMotion = useCallback((e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    const g = GRAVITY_EMA_ALPHA * gravityRef.current + (1 - GRAVITY_EMA_ALPHA) * mag;
    gravityRef.current = g;
    const dynamic = mag - g;
    const now = performance.now();

    if (!armedRef.current && dynamic > STEP_THRESHOLD) {
      armedRef.current = true;
      if (now - lastStepAtRef.current > MIN_STEP_INTERVAL_MS) {
        lastStepAtRef.current = now;
        setSteps((s) => s + 1);
      }
    } else if (armedRef.current && dynamic < STEP_THRESHOLD * STEP_RELEASE) {
      armedRef.current = false;
    }
  }, []);

  const detach = useCallback(() => {
    window.removeEventListener("devicemotion", handleMotion);
  }, [handleMotion]);

  const stop = useCallback(() => {
    detach();
    setTracking(false);
  }, [detach]);

  const reset = useCallback(() => setSteps(0), []);

  const start = useCallback(async () => {
    setError(null);
    if (!supported) {
      setPermission("unsupported");
      return;
    }
    let granted = permission === "granted";
    if (needsPermission && !granted) {
      try {
        const ctor = DeviceMotionEvent as DeviceMotionEventCtor;
        const res = await ctor.requestPermission?.();
        granted = res === "granted";
        setPermission(granted ? "granted" : "denied");
      } catch (e) {
        setError(e instanceof Error ? e.message : "motion permission failed");
        setPermission("denied");
        return;
      }
    }
    if (!granted) return;
    // Re-arm cleanly for a fresh walk.
    armedRef.current = false;
    lastStepAtRef.current = 0;
    window.addEventListener("devicemotion", handleMotion);
    setTracking(true);
  }, [supported, needsPermission, permission, handleMotion]);

  // Detach on unmount so a navigated-away counter doesn't keep listening.
  useEffect(() => detach, [detach]);

  return { supported, permission, tracking, steps, start, stop, reset, error };
}
