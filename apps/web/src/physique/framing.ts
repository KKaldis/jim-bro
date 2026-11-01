// Live framing check — a port of framing() from the original Python prototype.
// "full" (crown to heel in frame) is what the analysis needs for real-world
// scale; with the head or feet cut off it falls back to torso mode (ratios
// only), which is still a usable capture.

import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

// BlazePose landmark indices.
const NOSE = 0;
const LOWER = [25, 26, 27, 28]; // left/right knee, left/right ankle

export type Framing = "none" | "head_cut" | "feet_cut" | "full";

export function framingOf(landmarks: NormalizedLandmark[] | undefined): Framing {
  if (!landmarks?.length) return "none";
  const vis = (i: number) => landmarks[i]?.visibility ?? 0;
  const ys = landmarks.map((p) => p.y);
  if (vis(NOSE) < 0.5 || Math.min(...ys) < 0.03) return "head_cut";
  if (LOWER.some((i) => vis(i) < 0.5) || Math.max(...ys) > 0.97) return "feet_cut";
  return "full";
}
