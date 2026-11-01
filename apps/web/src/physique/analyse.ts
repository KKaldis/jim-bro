// Captured frames → physique report, on-device. Mirrors detect() in the
// original Python prototype: segmenter silhouette ∩ (dilated) pose
// mask, morphological clean-up, then the shared measurement code.

import {
  dilate,
  measureFrame,
  medianWidths,
  morphClose,
  morphOpen,
  physiqueReport,
  type FrameMeasurement,
  type Mask,
  type PhysiqueReport,
  type Point,
} from "@fa/shared/physique";
import { SEG_BACKGROUND, SEG_CLOTHES, type Models } from "./models";

// BlazePose landmark order (same list as segment.py POSE_NAMES).
const POSE_NAMES = [
  "nose",
  "left_eye_inner",
  "left_eye",
  "left_eye_outer",
  "right_eye_inner",
  "right_eye",
  "right_eye_outer",
  "left_ear",
  "right_ear",
  "mouth_left",
  "mouth_right",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_pinky",
  "right_pinky",
  "left_index",
  "right_index",
  "left_thumb",
  "right_thumb",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
  "left_heel",
  "right_heel",
  "left_foot_index",
  "right_foot_index",
];

/** What the report needs from the user's profile / last weigh-in. */
export type Subject = {
  sex: "male" | "female" | null;
  heightCm: number | null;
  weightKg: number | null;
  bodyFatPct: number | null;
  wristCm: number | null;
  ankleCm: number | null;
};

export type AnalysedFrame = {
  mask: Mask;
  measurement: FrameMeasurement;
  /** Whose outline was measured: the sharp segmenter, or the pose model's
   *  softer one when the segmenter lost the person (busy background). */
  outline: "segmenter" | "pose";
};

// Share of the pose model's body the segmenter must also cover for its
// (sharper) outline to be trusted.
const MIN_AGREEMENT = 0.8;

/** Pixel box around the person from the landmarks, with room for the crown,
 *  hands and feet the landmarks don't reach. */
function personBox(lms: { x: number; y: number; visibility?: number }[], w: number, h: number) {
  const pts = lms.filter((p) => (p.visibility ?? 0) > 0.3);
  const use = pts.length >= 8 ? pts : lms;
  const xs = use.map((p) => p.x * w);
  const ys = use.map((p) => p.y * h);
  const tall = Math.max(...ys) - Math.min(...ys);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - 0.12 * tall));
  const x1 = Math.min(w, Math.ceil(Math.max(...xs) + 0.12 * tall));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - 0.14 * tall));
  const y1 = Math.min(h, Math.ceil(Math.max(...ys) + 0.06 * tall));
  return { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Nearest-neighbour resample of a category/confidence array to w×h. */
function resample<T extends Uint8Array | Float32Array>(
  src: T,
  sw: number,
  sh: number,
  w: number,
  h: number,
  make: (n: number) => T,
): T {
  if (sw === w && sh === h) return src;
  const out = make(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
    for (let x = 0; x < w; x++)
      out[y * w + x] = src[sy * sw + Math.min(sw - 1, Math.floor((x * sw) / w))];
  }
  return out;
}

/** One captured frame → cleaned body mask + measurement (null: no person). */
export function analyseFrame(
  models: Models,
  frame: HTMLCanvasElement,
  heightCm: number | null,
  timestamp: number,
): AnalysedFrame | null {
  const w = frame.width;
  const h = frame.height;

  const pose = models.stillPose.detect(frame);
  const lms = pose.landmarks[0];
  const poseMask = pose.segmentationMasks?.[0];
  const poseConf = poseMask
    ? resample(
        poseMask.getAsFloat32Array(),
        poseMask.width,
        poseMask.height,
        w,
        h,
        (n) => new Float32Array(n),
      )
    : null;
  pose.segmentationMasks?.forEach((m) => m.close());
  if (!lms?.length) return null;

  // Segment only a box around the person: the model works at 256×256, so on
  // the whole frame a standing body is a thin strip squeezed in with the
  // room. Cropped, the body fills more of the input and less background
  // gets a vote.
  const box = personBox(lms, w, h);
  const crop = document.createElement("canvas");
  crop.width = box.w;
  crop.height = box.h;
  crop.getContext("2d")!.drawImage(frame, box.x0, box.y0, box.w, box.h, 0, 0, box.w, box.h);
  const seg = models.seg.segmentForVideo(crop, timestamp);
  const catMask = seg.categoryMask;
  if (!catMask) return null;
  const catCrop = resample(
    catMask.getAsUint8Array(),
    catMask.width,
    catMask.height,
    box.w,
    box.h,
    (n) => new Uint8Array(n),
  );
  catMask.close();
  const cat = new Uint8Array(w * h); // SEG_BACKGROUND outside the box
  for (let y = 0; y < box.h; y++)
    cat.set(catCrop.subarray(y * box.w, (y + 1) * box.w), (box.y0 + y) * w + box.x0);

  const segPerson: Mask = { width: w, height: h, data: new Uint8Array(w * h) };
  for (let i = 0; i < cat.length; i++) if (cat[i] !== SEG_BACKGROUND) segPerson.data[i] = 1;

  // Fuse with the pose model's own body mask. The segmenter has the sharper
  // edges but loses people against busy backgrounds (patterned curtains,
  // tattoos on a dark pattern); the pose model rarely does. When they agree,
  // keep the segmenter's outline and only drop what the pose model says is
  // not the person (furniture). When the segmenter missed a real share of
  // the body, measure the pose outline, plus segmenter detail along it.
  let person: Mask = segPerson;
  let outline: AnalysedFrame["outline"] = "segmenter";
  if (poseConf) {
    const pm: Mask = { width: w, height: h, data: new Uint8Array(w * h) };
    let poseSum = 0;
    let both = 0;
    for (let i = 0; i < poseConf.length; i++) {
      if (poseConf[i] > 0.5) {
        pm.data[i] = 1;
        poseSum++;
        if (segPerson.data[i]) both++;
      }
    }
    if (poseSum > 0) {
      const grown = dilate(pm, 15);
      const fused = new Uint8Array(w * h);
      const agree = both / poseSum >= MIN_AGREEMENT;
      if (!agree) outline = "pose";
      for (let i = 0; i < fused.length; i++) {
        const seg_ = segPerson.data[i] & grown.data[i];
        fused[i] = agree ? seg_ : seg_ | pm.data[i];
      }
      person = { width: w, height: h, data: fused };
    }
  }
  person = morphOpen(morphClose(person, 5), 5);

  let body = 0;
  let clothes = 0;
  for (let i = 0; i < person.data.length; i++) {
    if (!person.data[i]) continue;
    body++;
    if (cat[i] === SEG_CLOTHES) clothes++;
  }
  if (body === 0) return null;

  const landmarks: Record<string, Point> = {};
  const visibility: Record<string, number> = {};
  lms.forEach((p, i) => {
    landmarks[POSE_NAMES[i]] = [p.x * w, p.y * h];
    visibility[POSE_NAMES[i]] = p.visibility ?? 0;
  });

  try {
    const measurement = measureFrame(
      { mask: person, landmarks, visibility, clothesFraction: clothes / body },
      heightCm,
    );
    if (outline === "pose") {
      measurement.warnings.unshift(
        "The background made your outline hard to separate, so the pose model's softer outline was measured — widths may read slightly high. A plain wall behind you gives sharper numbers.",
      );
    }
    return { mask: person, measurement, outline };
  } catch {
    // Landmarks too odd to anchor the scans, or an outline that doesn't
    // span head to feet (see frameCheck) — never measure a fragment.
    return null;
  }
}

/**
 * Median-combine a burst into one report. Frames in the minority framing
 * mode are dropped, so one frame with the feet clipped can't drag the rest
 * into px-only torso mode.
 */
export function combineBurst(frames: AnalysedFrame[], s: Subject): PhysiqueReport | null {
  if (!frames.length) return null;
  const full = frames.filter((f) => f.measurement.mode === "full");
  const pool =
    full.length * 2 >= frames.length ? full : frames.filter((f) => f.measurement.mode === "torso");
  const ref = pool[pool.length - 1].measurement;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return physiqueReport({
    scale: {
      cmPerPx: median(pool.map((f) => f.measurement.front.cmPerPx)),
      heightPx: median(pool.map((f) => f.measurement.front.heightPx)),
    },
    sex: s.sex ?? "male",
    heightCm: s.heightCm,
    weightKg: s.weightKg,
    bfPct: s.bodyFatPct,
    wristCm: s.wristCm,
    ankleCm: s.ankleCm,
    mode: ref.mode,
    units: ref.front.units,
    widths: medianWidths(pool.map((f) => f.measurement.front.widths)),
    warnings: ref.warnings,
    torsoReason: ref.reason,
  });
}
