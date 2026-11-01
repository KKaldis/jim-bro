import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Camera, CircleHelp, Lock, RotateCcw, SwitchCamera, X } from "lucide-react";
import { DrawingUtils, PoseLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { PhysiqueReport } from "@fa/shared/physique";
import { Button } from "@/components/ui/button";
import { FlexLoader } from "@/components/FlexLoader";
import i18n from "@/i18n";
import { analyseFrame, combineBurst, type AnalysedFrame, type Subject } from "./analyse";
import { framingOf, type Framing } from "./framing";
import { GuideSheet, guideSeen } from "./GuideSheet";
import { ReportPanel } from "./ReportPanel";
import { SubjectGate } from "./SubjectGate";
import {
  loadModels,
  subscribeLoadProgress,
  SEG_BACKGROUND,
  SEG_CLOTHES,
  type LoadProgress,
  type Models,
} from "./models";

// Live on-device body scan. The phone sits
// on a shelf ~2.5 m away, so nothing here needs a tap once it's running: when
// the whole body has been in frame for a moment a countdown starts by itself,
// with beeps, and a short burst of frames is captured. Pose runs every video
// frame (lite model); the silhouette segmenter runs ~8×/s for the preview.
//
// Each burst frame is then measured (analyse.ts → @fa/shared/physique) and the
// widths median-combined into one report. Nothing leaves the device.

const READY_HOLD_MS = 1500; // full-body framing held this long → auto countdown
const AUTO_COUNTDOWN_S = 3;
const MANUAL_COUNTDOWN_S = 5; // a tap needs time to walk back into place
const SEG_EVERY_MS = 120;
// Frames measured per capture (consecutive video frames, ~0.2 s at 30 fps).
const BURST_FRAMES = 5;
// Torso levels labelled on the result photo (limbs get lines only).
const LABELLED_SCANS = ["shoulders", "chest", "waist", "hips", "neck"];

const FRAMING_TONE: Record<Framing, string> = {
  none: "bg-red-600",
  head_cut: "bg-amber-500",
  feet_cut: "bg-amber-500",
  full: "bg-emerald-600",
};
const SKELETON_COLOR: Record<Framing, string> = {
  none: "#ef4444",
  head_cut: "#f59e0b",
  feet_cut: "#f59e0b",
  full: "#10b981",
};

type Shot = {
  url: string;
  /** null when no frame of the burst had a measurable person. */
  report: PhysiqueReport | null;
};

/** The captured frame with the measured silhouette and scan lines drawn on. */
function renderShot(
  frame: HTMLCanvasElement,
  analysed: AnalysedFrame | null,
  report: PhysiqueReport | null,
): Promise<string> {
  const c = document.createElement("canvas");
  c.width = frame.width;
  c.height = frame.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(frame, 0, 0);
  if (analysed) {
    const { mask } = analysed;
    const tint = new ImageData(mask.width, mask.height);
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i]) tint.data.set([20, 184, 166, 70], i * 4);
    }
    const layer = document.createElement("canvas");
    layer.width = mask.width;
    layer.height = mask.height;
    layer.getContext("2d")!.putImageData(tint, 0, 0);
    ctx.drawImage(layer, 0, 0, c.width, c.height);

    const font = Math.max(14, Math.round(c.width / 32));
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    const lineW = Math.max(2, font / 7);
    for (const s of analysed.measurement.front.scans) {
      ctx.lineWidth = lineW;
      ctx.strokeStyle = "#f97316";
      ctx.beginPath();
      ctx.moveTo(s.p0[0], s.p0[1]);
      ctx.lineTo(s.p1[0], s.p1[1]);
      ctx.stroke();
      const value = report?.widths[s.name];
      if (!report || !LABELLED_SCANS.includes(s.name) || value == null) continue;
      const label = `${value} ${report.units}`;
      const x = Math.max(s.p0[0], s.p1[0]) + font / 2;
      const y = (s.p0[1] + s.p1[1]) / 2 + font / 3;
      ctx.lineWidth = font / 4;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(label, x, y);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x, y);
    }
  }
  return new Promise((resolve) =>
    c.toBlob(
      (b) => resolve(b ? URL.createObjectURL(b) : c.toDataURL("image/jpeg")),
      "image/jpeg",
      0.9,
    ),
  );
}

export function PhysiqueScanner({
  onClose,
  subject: profileSubject,
}: {
  onClose: () => void;
  subject: Subject;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const poseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  const [models, setModels] = useState<Models | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [camErr, setCamErr] = useState<string | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);

  const [framing, setFraming] = useState<Framing>("none");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [measuring, setMeasuring] = useState(false);
  // Height/sex typed into the gate win over the (possibly empty) profile.
  const [override, setOverride] = useState<Partial<Subject>>({});
  const subject: Subject = { ...profileSubject, ...override };
  // Without a height every width stays in pixels, so ask before scanning.
  const [gateOpen, setGateOpen] = useState(!profileSubject.heightCm || !profileSubject.sex);
  // Photo guidelines: shown on the first scan, then from the header's "?".
  const [guideOpen, setGuideOpen] = useState(() => !guideSeen());
  const paused = gateOpen || guideOpen;
  // Set by the Capture button; read inside the frame loop.
  const manualRef = useRef<number | null>(null);

  /* ---------------------------------------------------------- models -- */

  useEffect(() => {
    let cancelled = false;
    setLoadErr(null);
    const unsub = subscribeLoadProgress((p) => !cancelled && setProgress(p));
    loadModels().then(
      (m) => !cancelled && setModels(m),
      (e) => !cancelled && setLoadErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [loadAttempt]);

  /* ---------------------------------------------------------- camera -- */

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamErr(i18n.t("components.camera.noCameraApi"));
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    setVideoSize(null);
    const v = videoRef.current;
    // Rotating the phone mid-scan changes the stream's shape; the overlays
    // and the frame loop follow the video's real size.
    const onResize = () => v?.videoWidth && setVideoSize({ w: v.videoWidth, h: v.videoHeight });
    v?.addEventListener("resize", onResize);

    // Mobile browsers read width/height in the camera sensor's own landscape
    // frame and rotate to the screen, so asking for "720 × 1280" (portrait)
    // comes back landscape on many phones, while "1920 × 1080" comes back
    // portrait on an upright phone. A standing body wants portrait: more
    // pixels along its height.
    const open = (width: number, height: number) =>
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: width }, height: { ideal: height } },
        audio: false,
      });
    const portraitScreen = () => window.matchMedia("(orientation: portrait)").matches;
    const attach = async (s: MediaStream) => {
      if (!v) return;
      v.srcObject = s;
      await v.play();
    };

    (async () => {
      try {
        stream = await open(1920, 1080);
        if (cancelled) return;
        await attach(stream);
        // Some browsers don't rotate: try the other reading once, and keep
        // whichever stream comes back portrait (else the first one).
        if (!cancelled && v && portraitScreen() && v.videoWidth > v.videoHeight) {
          const retry = await open(1080, 1920).catch(() => null);
          if (retry && !cancelled) {
            const probe = retry.getVideoTracks()[0]?.getSettings();
            const portrait = probe?.width && probe?.height ? probe.height > probe.width : true;
            if (portrait) {
              stream.getTracks().forEach((tr) => tr.stop());
              stream = retry;
              await attach(stream);
            } else {
              retry.getTracks().forEach((tr) => tr.stop());
            }
          } else {
            retry?.getTracks().forEach((tr) => tr.stop());
          }
        }
        if (!cancelled && v) setVideoSize({ w: v.videoWidth, h: v.videoHeight });
      } catch (e) {
        if (!cancelled) {
          setCamErr(
            i18n.t("components.camera.unavailable", {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      v?.removeEventListener("resize", onResize);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [facing]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setStageSize({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the screen awake while the phone sits on the shelf.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    navigator.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => undefined);
    return () => void lock?.release().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => () => void audioRef.current?.close().catch(() => undefined), []);

  // Browsers only let audio start from a gesture; any tap in the scanner (the
  // one that opened it is gone by the time this lazy chunk mounts) unlocks it.
  const unlockAudio = () => {
    try {
      audioRef.current ??= new AudioContext();
      void audioRef.current.resume();
    } catch {
      // No Web Audio — the countdown is still on screen.
    }
  };

  const beep = useCallback((final: boolean) => {
    const ctx = audioRef.current;
    if (ctx && ctx.state === "running") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = final ? 1320 : 880;
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (final ? 0.4 : 0.15));
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    }
    navigator.vibrate?.(final ? 200 : 60);
  }, []);

  /* ------------------------------------------------------ frame loop -- */

  useEffect(() => {
    const v = videoRef.current;
    const poseCanvas = poseCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!models || !videoSize || shot || paused || !v || !poseCanvas || !maskCanvas) return;

    poseCanvas.width = videoSize.w;
    poseCanvas.height = videoSize.h;
    const poseCtx = poseCanvas.getContext("2d")!;
    const draw = new DrawingUtils(poseCtx);
    const maskCtx = maskCanvas.getContext("2d")!;
    let maskImage: ImageData | null = null;

    let raf = 0;
    let lastVideoTime = -1;
    let lastSeg = 0;
    let frames = 0;
    let fpsSince = performance.now();
    let current: Framing = "none";
    let readySince: number | null = null;
    let countdownStart: number | null = null;
    let countdownLen = AUTO_COUNTDOWN_S;
    let shown: number | null = null;
    let landmarks: NormalizedLandmark[] | undefined;

    // Consecutive raw frames, as the camera saw them (only the preview is
    // mirrored), collected once the countdown reaches zero.
    let burst: HTMLCanvasElement[] | null = null;
    const grab = () => {
      const c = document.createElement("canvas");
      c.width = videoSize.w;
      c.height = videoSize.h;
      c.getContext("2d")!.drawImage(v, 0, 0);
      return c;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (v.readyState < 2 || v.currentTime === lastVideoTime) return;
      lastVideoTime = v.currentTime;
      const now = performance.now();

      if (burst) {
        burst.push(grab());
        if (burst.length >= BURST_FRAMES) {
          cancelAnimationFrame(raf);
          void measureRef.current?.(burst);
        }
        return;
      }

      landmarks = models.pose.detectForVideo(v, now).landmarks[0];
      const f = framingOf(landmarks);
      if (f !== current) {
        current = f;
        setFraming(f);
      }
      poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
      if (landmarks) {
        const color = SKELETON_COLOR[f];
        draw.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color, lineWidth: 4 });
        draw.drawLandmarks(landmarks, { color: "#fff", fillColor: color, radius: 4, lineWidth: 1 });
      }

      if (now - lastSeg > SEG_EVERY_MS) {
        lastSeg = now;
        models.seg.segmentForVideo(v, now, (r) => {
          const m = r.categoryMask;
          if (!m) return;
          if (maskCanvas.width !== m.width || maskCanvas.height !== m.height) {
            maskCanvas.width = m.width;
            maskCanvas.height = m.height;
            maskImage = null;
          }
          maskImage ??= maskCtx.createImageData(m.width, m.height);
          const cat = m.getAsUint8Array();
          const px = maskImage.data;
          for (let i = 0; i < cat.length; i++) {
            const o = i * 4;
            if (cat[i] === SEG_BACKGROUND) {
              px[o + 3] = 0;
              continue;
            }
            const isClothes = cat[i] === SEG_CLOTHES;
            // Skin/hair teal, clothing violet — so loose clothing reads at a glance.
            px[o] = isClothes ? 139 : 20;
            px[o + 1] = isClothes ? 92 : 184;
            px[o + 2] = isClothes ? 246 : 166;
            px[o + 3] = 120;
          }
          maskCtx.putImageData(maskImage, 0, 0);
        });
      }

      frames++;
      if (now - fpsSince >= 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsSince)));
        frames = 0;
        fpsSince = now;
      }

      // A tap on Capture starts a longer countdown that framing can't cancel.
      if (manualRef.current != null && countdownStart == null) {
        countdownStart = now;
        countdownLen = MANUAL_COUNTDOWN_S;
      }
      const manual = manualRef.current != null;
      if (f === "full") {
        readySince ??= now;
        if (countdownStart == null && now - readySince >= READY_HOLD_MS) {
          countdownStart = now;
          countdownLen = AUTO_COUNTDOWN_S;
        }
      } else {
        readySince = null;
        if (countdownStart != null && !manual) countdownStart = null;
      }

      if (countdownStart == null) {
        if (shown != null) {
          shown = null;
          setCountdown(null);
        }
        return;
      }
      const left = Math.ceil(countdownLen - (now - countdownStart) / 1000);
      if (left <= 0) {
        manualRef.current = null;
        setCountdown(null);
        setMeasuring(true);
        beep(true);
        burst = [grab()];
        return;
      }
      if (left !== shown) {
        shown = left;
        setCountdown(left);
        beep(false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [models, videoSize, shot, paused, beep]);

  useEffect(
    () => () => {
      if (shot?.url.startsWith("blob:")) URL.revokeObjectURL(shot.url);
    },
    [shot],
  );

  // Burst → report. Frames are measured one per macrotask so the "Measuring"
  // spinner keeps animating on slower phones.
  const measureRef = useRef<((frames: HTMLCanvasElement[]) => Promise<void>) | null>(null);
  measureRef.current = async (frames) => {
    if (!models) return;
    const analysed: { a: AnalysedFrame; canvas: HTMLCanvasElement }[] = [];
    for (const canvas of frames) {
      await new Promise((r) => setTimeout(r, 0));
      const a = analyseFrame(models, canvas, subject.heightCm, performance.now());
      if (a) analysed.push({ a, canvas });
    }
    const report = combineBurst(
      analysed.map((x) => x.a),
      subject,
    );
    const last = analysed[analysed.length - 1];
    const url = await renderShot(
      last?.canvas ?? frames[frames.length - 1],
      last?.a ?? null,
      report,
    );
    setShot({ url, report });
    setMeasuring(false);
  };

  const retake = () => {
    setShot(null);
    setFraming("none");
  };

  /* ----------------------------------------------------------- render -- */

  const mirrored = facing === "user";
  const loadingModels = !models && !loadErr;
  // The preview box is the largest rectangle with the video's shape that
  // fits the stage, so the overlay canvases sit exactly on the picture —
  // portrait or landscape stream, portrait or landscape screen.
  const box =
    videoSize && stageSize
      ? (() => {
          const k = Math.min(stageSize.w / videoSize.w, stageSize.h / videoSize.h);
          return { width: Math.floor(videoSize.w * k), height: Math.floor(videoSize.h * k) };
        })()
      : undefined;

  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-100 flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label={t("physique.title")}
      onPointerDown={unlockAudio}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-semibold">{t("physique.title")}</span>
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] tracking-wide uppercase">
          {t("physique.beta")}
        </span>
        {/* Always visible: the camera feed never leaves the phone. */}
        <span
          className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300"
          title={t("physique.privacy.badgeTitle")}
        >
          <Lock className="size-3" /> {t("physique.privacy.badge")}
        </span>
        <div className="ms-auto flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={() => setGuideOpen(true)}
            aria-label={t("physique.guide.open")}
          >
            <CircleHelp className="size-5" />
          </Button>
          {!shot && (
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/10 hover:text-white"
              onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
              aria-label={t("physique.switchCamera")}
            >
              <SwitchCamera className="size-5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X className="size-5" />
          </Button>
        </div>
      </div>

      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        {camErr ? (
          <div className="max-w-sm space-y-2 p-6 text-center">
            <p className="text-sm text-red-300">{camErr}</p>
            <p className="text-sm text-white/70">{t("components.camera.grantPermission")}</p>
          </div>
        ) : (
          <>
            {shot && (
              <div className="absolute inset-0 overflow-y-auto">
                <img
                  src={shot.url}
                  alt=""
                  className="mx-auto max-h-[60vh] max-w-full object-contain"
                />
                <div className="mx-auto max-w-xl p-4">
                  {shot.report ? (
                    <ReportPanel
                      report={shot.report}
                      subject={subject}
                      onAddHeight={() => {
                        retake();
                        setGateOpen(true);
                      }}
                      onTips={() => setGuideOpen(true)}
                    />
                  ) : (
                    <div className="space-y-3 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4">
                      <p className="text-sm text-amber-100">{t("physique.result.noPerson")}</p>
                      <Button size="sm" variant="secondary" onClick={() => setGuideOpen(true)}>
                        {t("physique.guide.open")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* Stays mounted under the review image: the stream is attached
                once per camera, so Retake resumes the same preview. The box
                takes the video's aspect ratio so the overlays line up. */}
            <div
              className={`relative max-h-full max-w-full ${mirrored ? "-scale-x-100" : ""} ${shot ? "hidden" : ""}`}
              style={box}
            >
              <video
                ref={videoRef}
                className="size-full object-contain"
                playsInline
                muted
                autoPlay
              />
              <canvas
                ref={maskCanvasRef}
                className="pointer-events-none absolute inset-0 size-full"
              />
              <canvas
                ref={poseCanvasRef}
                className="pointer-events-none absolute inset-0 size-full"
              />
            </div>
          </>
        )}

        {measuring && !shot && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
            <FlexLoader className="size-12 text-white" />
            <p className="text-sm text-white/80">{t("physique.measuring")}</p>
          </div>
        )}

        {countdown != null && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-[9rem] leading-none font-black drop-shadow-[0_4px_16px_rgba(0,0,0,0.8)]">
              {countdown}
            </span>
          </div>
        )}

        {(loadingModels || loadErr) && !camErr && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6">
            {loadErr ? (
              <div className="max-w-sm space-y-3 text-center">
                <p className="text-sm text-red-300">
                  {t("physique.loading.failed", { error: loadErr })}
                </p>
                <Button variant="secondary" onClick={() => setLoadAttempt((n) => n + 1)}>
                  {t("physique.loading.retry")}
                </Button>
              </div>
            ) : (
              <ModelProgress progress={progress} />
            )}
          </div>
        )}

        {/* Over the loading screen too: answering it is a good use of the
            first-time download. */}
        {gateOpen && !guideOpen && !shot && !camErr && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4">
            <SubjectGate
              subject={subject}
              onDone={(s) => {
                setOverride((o) => ({ ...o, ...s }));
                setGateOpen(false);
              }}
              onSkip={() => setGateOpen(false)}
            />
          </div>
        )}

        {guideOpen && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-4">
            <GuideSheet onDone={() => setGuideOpen(false)} />
          </div>
        )}
      </div>

      <div className="space-y-2 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {shot ? (
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-white/50">
              {models
                ? t("physique.perf", {
                    fps: fps ?? "–",
                    delegate: models.delegate,
                    s: (models.loadMs / 1000).toFixed(1),
                    source: models.fromCache
                      ? t("physique.source.cache")
                      : t("physique.source.network"),
                  })
                : ""}
            </span>
            <Button onClick={retake} variant="secondary" className="gap-1.5">
              <RotateCcw className="size-4" /> {t("physique.result.retake")}
            </Button>
          </div>
        ) : models && !camErr && !paused ? (
          <>
            <div
              className={`rounded-xl px-4 py-3 text-center text-lg font-bold ${FRAMING_TONE[framing]}`}
              aria-live="polite"
            >
              {t(`physique.framing.${framing}`)}
            </div>
            <p className="text-center text-xs text-white/70">{t("physique.hint")}</p>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-white/50">
                {fps != null ? `${fps} fps · ${models.delegate}` : ""}
              </span>
              <Button
                onClick={() => {
                  manualRef.current = performance.now();
                }}
                disabled={countdown != null || measuring}
                className="gap-1.5"
              >
                <Camera className="size-4" /> {t("physique.capture")}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function ModelProgress({ progress }: { progress: LoadProgress | null }) {
  const { t } = useTranslation();
  if (!progress || progress.phase === "init" || progress.fromCache) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <FlexLoader className="size-12 text-white" />
        <p className="text-sm text-white/80">
          {/* No report yet means the cache lookup is still running. */}
          {progress?.phase === "download"
            ? t("physique.loading.cached")
            : t("physique.loading.init")}
        </p>
      </div>
    );
  }
  const mb = (b: number) => (b / 1_000_000).toFixed(1);
  const pct = Math.min(100, (progress.loaded / progress.total) * 100);
  return (
    <div className="w-full max-w-xs space-y-2 text-center">
      <p className="font-semibold">{t("physique.loading.download")}</p>
      <div className="h-2 overflow-hidden rounded-full bg-white/15">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="font-mono text-xs text-white/70">
        {t("physique.loading.mb", { loaded: mb(progress.loaded), total: mb(progress.total) })}
      </p>
      <p className="text-xs text-white/60">{t("physique.loading.oneTime")}</p>
      <p className="flex items-center justify-center gap-1.5 text-xs text-emerald-300/90">
        <Lock className="size-3" /> {t("physique.privacy.loading")}
      </p>
    </div>
  );
}
