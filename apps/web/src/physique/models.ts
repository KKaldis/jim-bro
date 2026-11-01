// Loads the on-device body-scan models: MediaPipe's pose landmarker (lite —
// fast enough for a live preview on mid-range phones) and the multiclass
// selfie segmenter (person / skin / clothes silhouette). Everything runs in
// the browser; no frame ever leaves the device.
//
// The wasm runtime and both models go through modelCache, so only the first
// open downloads anything. The created tasks are kept for the session, so
// reopening the scanner is instant.

import { ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";
import simdLoaderUrl from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import simdBinaryUrl from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import nosimdLoaderUrl from "@mediapipe/tasks-vision/vision_wasm_nosimd_internal.js?url";
import nosimdBinaryUrl from "@mediapipe/tasks-vision/vision_wasm_nosimd_internal.wasm?url";
import { fetchCached, pruneStaleCaches } from "./modelCache";

// Pinned model versions (not `latest`): the URL is the cache key, so a pinned
// URL is what makes "cached" mean "the same model".
const MODEL_BASE = "https://storage.googleapis.com/mediapipe-models";
const POSE_MODEL_URL = `${MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`;
const SEG_MODEL_URL = `${MODEL_BASE}/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`;

// Category ids of selfie_multiclass_256x256.
export const SEG_BACKGROUND = 0;
export const SEG_CLOTHES = 4;

// Sizes for the progress bar before each response's Content-Length arrives.
const APPROX_BYTES = {
  loader: 330_000,
  wasm: 11_800_000,
  pose: 5_780_000,
  seg: 16_370_000,
};

export type LoadProgress = {
  loaded: number;
  total: number;
  /** False once any asset had to come over the network — i.e. a first open. */
  fromCache: boolean;
  phase: "download" | "init";
};

export type Models = {
  pose: PoseLandmarker;
  /** Same model in IMAGE mode with person masks, for measuring captured frames. */
  stillPose: PoseLandmarker;
  seg: ImageSegmenter;
  delegate: "GPU" | "CPU";
  loadMs: number;
  fromCache: boolean;
};

// The same probe the tasks-vision bundle uses to pick its SIMD build.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

let loading: Promise<Models> | null = null;
// Progress fans out to whoever is watching now: a scanner closed mid-download
// and reopened must pick the bar up where it is, not wait on a dead callback.
const listeners = new Set<(p: LoadProgress) => void>();
let lastProgress: LoadProgress | null = null;
const onProgress = (p: LoadProgress) => {
  lastProgress = p;
  listeners.forEach((fn) => fn(p));
};

export function subscribeLoadProgress(fn: (p: LoadProgress) => void): () => void {
  listeners.add(fn);
  if (lastProgress) fn(lastProgress);
  return () => listeners.delete(fn);
}

/** Loads once per session; a failed load is forgotten so the next open retries. */
export function loadModels(): Promise<Models> {
  loading ??= load().catch((e) => {
    loading = null;
    lastProgress = null;
    throw e;
  });
  return loading;
}

async function load(): Promise<Models> {
  const t0 = performance.now();
  void pruneStaleCaches();

  const simd = WebAssembly.validate(SIMD_PROBE);
  const assets = {
    loader: simd ? simdLoaderUrl : nosimdLoaderUrl,
    wasm: simd ? simdBinaryUrl : nosimdBinaryUrl,
    pose: POSE_MODEL_URL,
    seg: SEG_MODEL_URL,
  };
  type Key = keyof typeof assets;
  const keys = Object.keys(assets) as Key[];
  const loaded = Object.fromEntries(keys.map((k) => [k, 0])) as Record<Key, number>;
  const totals = { ...APPROX_BYTES };
  let fromCache = true;
  const report = () =>
    onProgress({
      loaded: keys.reduce((s, k) => s + Math.min(loaded[k], totals[k]), 0),
      total: keys.reduce((s, k) => s + totals[k], 0),
      fromCache,
      phase: "download",
    });

  const fetched = await Promise.all(
    keys.map(async (k) => {
      const r = await fetchCached(assets[k], (l, t, cached) => {
        if (!cached) fromCache = false;
        loaded[k] = l;
        // A gzip-encoded response reports compressed Content-Length but
        // decompressed bytes, so never let the total fall below what arrived.
        totals[k] = Math.max(t ?? totals[k], l);
        report();
      });
      return [k, r.bytes] as const;
    }),
  );
  const bytes = Object.fromEntries(fetched) as Record<Key, Uint8Array<ArrayBuffer>>;
  onProgress({ loaded: 1, total: 1, fromCache, phase: "init" });

  // The runtime loads its loader via <script src> and the binary via
  // locateFile, so blob URLs over the cached bytes stand in for the network.
  const fileset = {
    wasmLoaderPath: URL.createObjectURL(new Blob([bytes.loader], { type: "text/javascript" })),
    wasmBinaryPath: URL.createObjectURL(new Blob([bytes.wasm], { type: "application/wasm" })),
  };

  const create = async (delegate: "GPU" | "CPU") => {
    const pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: bytes.pose, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    // The live pose skips masks (they cost every frame); the still one keeps
    // them — the original prototype intersects them with the segmenter to drop furniture.
    const stillPose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: bytes.pose, delegate },
      runningMode: "IMAGE",
      numPoses: 1,
      outputSegmentationMasks: true,
    });
    const seg = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: bytes.seg, delegate },
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
    return { pose, stillPose, seg };
  };

  let delegate: "GPU" | "CPU" = "GPU";
  let tasks: Awaited<ReturnType<typeof create>>;
  try {
    tasks = await create("GPU");
  } catch {
    // No usable WebGL2 (older iOS, blocklisted GPUs): slower, but works.
    delegate = "CPU";
    tasks = await create("CPU");
  }
  return { ...tasks, delegate, loadMs: Math.round(performance.now() - t0), fromCache };
}
