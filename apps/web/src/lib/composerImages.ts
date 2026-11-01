import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFeature } from "./features";

// Shared image-attachment plumbing for the chat composer, used by both the
// desktop Chat panel and the mobile coach bar (ChatDock) via useChatComposer.
// Kept here (not inline in Chat) so the two inputs share one implementation.

// Mirror of apps/server/src/schemas.ts limits — keep in sync.
export const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof ALLOWED_IMAGE_MIME)[number];
export const MAX_IMAGE_B64_LEN = 10_000_000;
export const MAX_IMAGES_PER_TURN = 6;

// A staged image in the composer: `data` is the base64 payload (no data: prefix)
// sent to the server; `previewUrl` is an object URL for the local thumbnail.
export type PendingImage = {
  id: string;
  media_type: ImageMime;
  data: string;
  previewUrl: string;
  name: string;
};

// The on-the-wire shape sent to /chat/stream and mirrored into a user turn.
export type OutgoingImage = { media_type: ImageMime; data: string };

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result;
      if (typeof result !== "string") {
        reject(new Error("unexpected reader result"));
        return;
      }
      const comma = result.indexOf(",");
      // Strip the "data:image/jpeg;base64," prefix, keep only the base64 payload.
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// Owns the staged-image list plus ingest/remove/clear and object-URL cleanup.
// Tier-gates attachment on the `ai_image` feature and localizes its own errors.
export function usePendingImages() {
  const { t } = useTranslation();
  const canImage = useFeature("ai_image");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  // Mirror of `pending` so the unmount cleanup revokes URLs for images added
  // after mount (an effect with [] deps would capture the first-render value).
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(
    () => () => {
      pendingRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    },
    [],
  );

  const ingestFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!canImage) return; // no vision model — block all attach paths
    setAttachErr(null);

    const room = Math.max(0, MAX_IMAGES_PER_TURN - pending.length);
    if (room === 0) {
      setAttachErr(t("chat.attach.maxPerTurn", { n: MAX_IMAGES_PER_TURN }));
      return;
    }

    const accepted: PendingImage[] = [];
    const errs: string[] = [];
    const list = Array.from(files).slice(0, room);
    for (const f of list) {
      if (!ALLOWED_IMAGE_MIME.includes(f.type as ImageMime)) {
        errs.push(
          t("chat.attach.unsupportedType", {
            name: f.name,
            type: f.type || t("chat.attach.unknownType"),
          }),
        );
        continue;
      }
      try {
        const data = await fileToBase64(f);
        if (data.length > MAX_IMAGE_B64_LEN) {
          errs.push(t("chat.attach.tooLarge", { name: f.name }));
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          media_type: f.type as ImageMime,
          data,
          previewUrl: URL.createObjectURL(f),
          name: f.name,
        });
      } catch (e) {
        errs.push(
          t("chat.attach.readError", {
            name: f.name,
            error: e instanceof Error ? e.message : t("chat.attach.readFailed"),
          }),
        );
      }
    }

    if (accepted.length) setPending((p) => [...p, ...accepted]);
    if (files.length > room) errs.push(t("chat.attach.onlyFirst", { n: room }));
    if (errs.length) setAttachErr(errs.join(" · "));
  };

  const removePending = (id: string) => {
    setPending((p) => {
      const target = p.find((x) => x.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return p.filter((x) => x.id !== id);
    });
  };

  // Drop all staged images (after a send, or a manual clear).
  const clear = () => {
    pendingRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPending([]);
    setAttachErr(null);
  };

  const outgoing: OutgoingImage[] = pending.map((p) => ({
    media_type: p.media_type,
    data: p.data,
  }));

  return {
    pending,
    attachErr,
    setAttachErr,
    ingestFiles,
    removePending,
    clear,
    outgoing,
    canImage,
  };
}
