// On-device barcode decoding. Prefers the browser's native BarcodeDetector
// (hardware-accelerated, zero bundle cost — Chrome/Edge/Android WebView) and
// falls back to the zxing-wasm ponyfill, dynamically imported so the wasm only
// downloads on browsers that lack native support (notably iOS Safari + Firefox).
//
// This is the on-device tier of the food-scan cascade: a decoded barcode goes
// to GET /foods/barcode/:code (pantry → food index); a decode failure routes
// the user to the AI vision path (POST /foods/scan). See CameraModal.

// Symbologies that show up on grocery packaging: retail EAN/UPC plus a few
// linear formats some labels use. Kept narrow so the decoder isn't hunting for
// QR / PDF417 it will never see on a food item (faster, fewer false reads).
export const FOOD_BARCODE_FORMATS = [
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "code_128",
  "code_39",
  "itf",
] as const;

export type DetectedBarcode = { rawValue: string; format: string };

export interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type NativeBarcodeDetector = {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

// Build a detector, native-first. Returns null only when neither path can be
// constructed — the caller should then send the user straight to the photo/AI
// fallback instead of a dead scanner.
export async function createBarcodeDetector(): Promise<BarcodeDetectorLike | null> {
  const formats = [...FOOD_BARCODE_FORMATS];
  const native = (globalThis as unknown as { BarcodeDetector?: NativeBarcodeDetector })
    .BarcodeDetector;
  if (native) {
    try {
      // Some engines expose the class but support a subset of formats; only
      // request the ones they actually decode (an unsupported format throws).
      const supported = (await native.getSupportedFormats?.()) ?? formats;
      const use = formats.filter((f) => supported.includes(f));
      return new native(use.length ? { formats: use } : undefined);
    } catch {
      // Native present but unusable — fall through to the wasm ponyfill.
    }
  }
  try {
    // Self-host the zxing wasm rather than letting it fetch from a CDN at
    // runtime: keeps decoding on-device (this app deliberately self-hosts its
    // food data too) and lets the installed PWA scan offline. Vite emits the
    // wasm as a hashed asset and the service worker precaches it. The version
    // is pinned to match barcode-detector's zxing-wasm dependency.
    const [{ BarcodeDetector, prepareZXingModule }, wasmUrl] = await Promise.all([
      import("barcode-detector/ponyfill"),
      import("zxing-wasm/reader/zxing_reader.wasm?url").then((m) => m.default),
    ]);
    prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith(".wasm") ? wasmUrl : prefix + path,
      },
    });
    return new BarcodeDetector({ formats });
  } catch {
    return null;
  }
}
