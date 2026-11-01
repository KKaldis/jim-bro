// Binary body-mask primitives for the physique scan — the handful of OpenCV
// operations the scan needs (morphology, largest blob, row runs), in plain
// TypeScript so the measurement code runs in the browser and in bun tests.

export type Mask = {
  width: number;
  height: number;
  /** Row-major, one byte per pixel: nonzero = body. */
  data: Uint8Array;
};

/** (x, y) in pixels, image coords (y grows down). */
export type Point = readonly [number, number];

export function emptyMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

/** Contiguous [x0, x1] (inclusive) foreground runs in row y. */
export function runsInRow(m: Mask, y: number): [number, number][] {
  if (y < 0 || y >= m.height) return [];
  const out: [number, number][] = [];
  const row = y * m.width;
  let start = -1;
  for (let x = 0; x < m.width; x++) {
    const on = m.data[row + x] !== 0;
    if (on && start < 0) start = x;
    else if (!on && start >= 0) {
      out.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, m.width - 1]);
  return out;
}

/** The run in row y that contains column x (null if x is background). */
export function runContaining(m: Mask, y: number, x: number): [number, number] | null {
  const xi = Math.round(x);
  for (const r of runsInRow(m, y)) if (r[0] <= xi && xi <= r[1]) return r;
  return null;
}

/** [topY, bottomY] of the foreground. */
export function verticalExtent(m: Mask): [number, number] {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++) {
      if (m.data[row + x]) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  if (top < 0) throw new Error("empty mask");
  return [top, bottom];
}

/** Keep only the largest 8-connected blob (drops stray segmentation islands). */
export function largestComponent(m: Mask): Mask {
  const { width: w, height: h, data } = m;
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || labels[i]) continue;
    const label = ++next;
    let size = 0;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = label;
    while (sp) {
      const p = stack[--sp];
      size++;
      const px = p % w;
      const py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (data[q] && !labels[q]) {
            labels[q] = label;
            stack[sp++] = q;
          }
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = label;
    }
  }
  const out = emptyMask(w, h);
  if (!best) return out;
  for (let i = 0; i < labels.length; i++) out.data[i] = labels[i] === best ? 1 : 0;
  return out;
}

// Box-kernel morphology, separable (a k×k box max/min is a row pass then a
// column pass). Out-of-image pixels are ignored, matching OpenCV's defaults:
// dilation doesn't grow from outside, erosion doesn't eat in from the edge.
function boxPass(
  src: Uint8Array,
  w: number,
  h: number,
  r: number,
  horizontal: boolean,
  dilate: boolean,
) {
  const out = new Uint8Array(src.length);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const at = (line: number, i: number) => (horizontal ? line * w + i : i * w + line);
  for (let line = 0; line < lines; line++) {
    let ones = 0;
    let lo = 0;
    let hi = -1;
    for (let i = 0; i < len; i++) {
      const want = Math.min(len - 1, i + r);
      while (hi < want) ones += src[at(line, ++hi)] ? 1 : 0;
      const from = Math.max(0, i - r);
      while (lo < from) ones -= src[at(line, lo++)] ? 1 : 0;
      const n = hi - lo + 1;
      out[at(line, i)] = dilate ? (ones > 0 ? 1 : 0) : ones === n ? 1 : 0;
    }
  }
  return out;
}

function morph(m: Mask, k: number, dilate: boolean): Mask {
  const r = Math.floor(k / 2);
  const rows = boxPass(m.data, m.width, m.height, r, true, dilate);
  return {
    width: m.width,
    height: m.height,
    data: boxPass(rows, m.width, m.height, r, false, dilate),
  };
}

export const dilate = (m: Mask, k: number) => morph(m, k, true);
export const erode = (m: Mask, k: number) => morph(m, k, false);
/** Close small holes. */
export const morphClose = (m: Mask, k: number) => erode(dilate(m, k), k);
/** Drop small specks. */
export const morphOpen = (m: Mask, k: number) => dilate(erode(m, k), k);
