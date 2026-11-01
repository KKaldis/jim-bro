import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Camera, ScanBarcode } from "lucide-react";
import { Button } from "./ui/button";
import { createBarcodeDetector, type BarcodeDetectorLike } from "../lib/barcodeScanner";
import i18n from "../i18n";

// Full-screen live-camera capture. Opens the rear camera (when available),
// shows a preview, and hands a JPEG Blob back via onCapture. Shared by the
// chat composer and the add-food flow. Falls back to a clear error (with a
// nudge to use upload) when getUserMedia is unavailable or denied.
//
// Barcode mode (scan + onDetect): runs an on-device barcode detector over the
// live feed and emits the decoded digits via onDetect. The "Snap photo instead"
// action still fires onCapture, so the caller can fall back to AI recognition
// when the code won't read; omit onCapture to scan-only (no photo fallback).
export function CameraModal({
  onCapture,
  onClose,
  scan = false,
  onDetect,
}: {
  onCapture?: (blob: Blob) => void;
  onClose: () => void;
  // Enable continuous on-device barcode detection over the live feed.
  scan?: boolean;
  // Called once with the decoded barcode value when scan mode gets a read.
  onDetect?: (code: string) => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // In scan mode: null = still probing for a detector, true/false once known.
  const [canScan, setCanScan] = useState<boolean | null>(scan ? null : false);
  // After a few seconds with no read, nudge the user toward the photo fallback.
  const [scanStalled, setScanStalled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setErr(i18n.t("components.camera.noCameraApi"));
      return;
    }

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          try {
            await v.play();
          } catch (e) {
            if (!cancelled) {
              setErr(
                i18n.t("components.camera.previewFailed", {
                  error: e instanceof Error ? e.message : String(e),
                }),
              );
            }
            return;
          }
          if (!cancelled) setReady(true);
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setErr(i18n.t("components.camera.unavailable", { error: msg }));
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Barcode detection loop. Starts once the video is playing; polls the live
  // frame a few times a second and fires onDetect on the first read. Throttled
  // (not every rAF) and non-overlapping so it stays smooth on low-end phones.
  useEffect(() => {
    if (!scan || !ready) return;
    let cancelled = false;
    let detector: BarcodeDetectorLike | null = null;
    let busy = false;
    let fired = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    (async () => {
      detector = await createBarcodeDetector();
      if (cancelled) return;
      if (!detector) {
        setCanScan(false);
        return;
      }
      setCanScan(true);
      interval = setInterval(async () => {
        const v = videoRef.current;
        if (busy || fired || !v || !v.videoWidth) return;
        busy = true;
        try {
          const hits = await detector!.detect(v);
          const code = hits.find((h) => h.rawValue)?.rawValue;
          if (!cancelled && code && !fired) {
            fired = true;
            onDetect?.(code);
          }
        } catch {
          // Transient decode error on a blurry frame — try the next tick.
        } finally {
          busy = false;
        }
      }, 350);
    })();

    const stallTimer = setTimeout(() => {
      if (!cancelled && !fired) setScanStalled(true);
    }, 7000);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      clearTimeout(stallTimer);
    };
  }, [scan, ready, onDetect]);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture?.(blob);
      },
      "image/jpeg",
      0.92,
    );
  };

  // Portal to <body> so the overlay escapes any parent stacking context — when
  // launched from inside a Radix Dialog (which itself portals to body at z-50),
  // an inline-rendered modal would otherwise be trapped below it regardless of
  // its own z-index.
  return createPortal(
    <div
      // pointer-events-auto: when launched from inside a Radix Dialog, the modal
      // sets `pointer-events: none` on <body>, which this portal would otherwise
      // inherit — leaving the camera's own buttons dead and taps falling through
      // to the dialog overlay beneath (which dismisses it).
      className="pointer-events-auto fixed inset-0 z-100 flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={scan ? t("components.camera.scanAria") : t("components.camera.photoAria")}
    >
      <div className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-edge bg-background p-3 shadow-overlay">
        {err ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{err}</p>
            <p className="text-sm text-muted-foreground">
              {t("components.camera.grantPermission")}
            </p>
            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={onClose}>
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="relative">
              <video
                ref={videoRef}
                className="max-h-[70vh] w-full rounded-md bg-black object-contain"
                playsInline
                muted
                autoPlay
              />
              {scan && (
                // Aiming guide — a horizontal band the user lines the barcode up
                // with. Purely visual; detection runs over the whole frame.
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-24 w-3/4 max-w-sm rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
                </div>
              )}
            </div>

            {scan && (
              <p className="text-center text-sm text-muted-foreground">
                {canScan === false
                  ? onCapture
                    ? t("components.camera.notSupported")
                    : t("components.camera.notSupportedTypeIt")
                  : scanStalled
                    ? onCapture
                      ? t("components.camera.stalled")
                      : t("components.camera.stalledNoPhoto")
                    : t("components.camera.aim")}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              {onCapture && (
                <Button type="button" onClick={snap} disabled={!ready} className="gap-1.5">
                  {scan ? <ScanBarcode className="size-4" /> : <Camera className="size-4" />}
                  {scan ? t("components.camera.snapInstead") : t("components.camera.snap")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
