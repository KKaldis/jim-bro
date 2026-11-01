import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BicepsFlexed, Camera, Image as ImageIcon, Mic, Plus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CameraModal } from "./CameraModal.tsx";
import { FeatureBadge } from "../lib/features";
import { useChatBridge } from "../lib/chatBridge";
import { ALLOWED_IMAGE_MIME, MAX_IMAGES_PER_TURN } from "../lib/composerImages";
import { useUiStore } from "../lib/uiStore";
import type { ChatComposerApi } from "../lib/useChatComposer";
import { cn } from "../lib/utils";

const LANGUAGES: ReadonlyArray<{ code: string; label: string; short: string }> = [
  { code: "en-US", label: "English (US)", short: "EN" },
  { code: "en-GB", label: "English (UK)", short: "GB" },
  { code: "el-GR", label: "Ελληνικά", short: "GR" },
  { code: "ar-SA", label: "العربية", short: "AR" },
  { code: "sq-AL", label: "Shqip", short: "SQ" },
  { code: "fa-IR", label: "فارسی", short: "FA" },
  { code: "ur-PK", label: "اردو", short: "UR" },
  { code: "es-ES", label: "Español", short: "ES" },
  { code: "fr-FR", label: "Français", short: "FR" },
  { code: "de-DE", label: "Deutsch", short: "DE" },
  { code: "it-IT", label: "Italiano", short: "IT" },
  { code: "pt-PT", label: "Português", short: "PT" },
  { code: "nl-NL", label: "Nederlands", short: "NL" },
  { code: "tr-TR", label: "Türkçe", short: "TR" },
  { code: "ja-JP", label: "日本語", short: "JP" },
  { code: "zh-CN", label: "中文", short: "CN" },
];

// Reply-language picker bound to the shared bridge locale. Renders a compact
// 2-letter code (GR, EN, …) below md and the full label at desktop widths.
function LanguagePicker({ dense = false }: { dense?: boolean }) {
  const { t } = useTranslation();
  const locale = useChatBridge((s) => s.locale);
  const setLocale = useChatBridge((s) => s.setLocale);
  // Below the app's md breakpoint (768px) render the code compactly (GR, EN, …).
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => setCompact(!mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const known = LANGUAGES.some((l) => l.code === locale);
  return (
    <Select
      value={known ? locale : "__custom"}
      onValueChange={(v) => {
        if (v === "__custom") return;
        setLocale(v);
      }}
    >
      <SelectTrigger
        className={cn(
          "w-auto rounded-e-none border-0",
          dense ? "h-7 gap-1 px-1.5" : "h-9 px-2",
          compact ? "gap-1" : "min-w-32 gap-2",
        )}
        title={t("chat.language.title")}
        aria-label={t("chat.language.label")}
      >
        {compact ? (
          <span className={cn("font-semibold", dense ? "text-[11px]" : "text-xs")}>
            {LANGUAGES.find((l) => l.code === locale)?.short ?? locale.slice(0, 2).toUpperCase()}
          </span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent>
        {LANGUAGES.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.label}
          </SelectItem>
        ))}
        {!known && <SelectItem value="__custom">{locale}</SelectItem>}
      </SelectContent>
    </Select>
  );
}

// The language picker + mic dictation as one bordered segmented control. Shared
// by the desktop composer's control row and the mobile coach bar's handle so the
// widget reads identically in both places. `onToggle`/`listening` come from the
// consumer (the dock wires a tap to expand-then-dictate).
export function LangMicGroup({
  listening,
  onToggle,
  dense = false,
  disabled = false,
}: {
  listening: boolean;
  onToggle: () => void;
  dense?: boolean;
  /** Mic off, e.g. without AI chat there is nothing to dictate into. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="pointer-events-auto flex items-center rounded-md border bg-background">
      <LanguagePicker dense={dense} />
      <Button
        type="button"
        variant={listening ? "secondary" : "ghost"}
        size="icon"
        onClick={onToggle}
        disabled={disabled}
        title={listening ? t("chat.dictation.stop") : t("chat.dictation.start")}
        aria-label={t("chat.dictation.toggle")}
        className={cn(
          "rounded-s-none border-0 border-s",
          dense && "size-7",
          listening && "text-destructive",
        )}
      >
        <Mic className={cn(listening && "animate-pulse", dense ? "size-3.5" : "size-4")} />
      </Button>
    </div>
  );
}

// The shared chat input surface: staged-image previews, textarea, attach menu
// (camera + upload), and send. Driven by a useChatComposer() instance. Two
// layouts:
//   - "panel" (desktop Chat): controls overlaid on a tall resizable textarea,
//     with the language+mic group inline; this is the original desktop look.
//   - "dock" (mobile coach bar): a compact stacked textarea + controls row; the
//     language+mic group is rendered by the dock's handle instead, so it stays
//     visible whether the bar is collapsed or open.
export function ChatComposer({
  composer,
  variant,
}: {
  composer: ChatComposerApi;
  variant: "panel" | "dock";
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const panel = variant === "panel";
  const requestView = useUiStore((s) => s.requestView);
  // A locked attach option opens the usage page, which explains the AI setup.
  const attachOr = (open: () => void) => () => (composer.canImage ? open() : requestView("usage"));

  const controls = (
    <>
      <DropdownMenu>
        {/* The menu opens even without image access: locked options show
            greyed with their lock badge beside them and open the usage page. */}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={composer.busy || composer.pending.length >= MAX_IMAGES_PER_TURN}
            title={composer.canImage ? t("chat.attachImage") : t("chat.imageNeedsModel")}
            aria-label={t("chat.attach.label")}
            className="pointer-events-auto"
          >
            <Plus className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuItem
            onClick={attachOr(() => setCameraOpen(true))}
            className={cn(!composer.canImage && "text-muted-foreground")}
          >
            <Camera className="me-2 size-4" />
            {t("chat.takePhoto")}
            <FeatureBadge name="ai_image" className="ms-auto ps-2" />
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={attachOr(() => fileInputRef.current?.click())}
            className={cn(!composer.canImage && "text-muted-foreground")}
          >
            <ImageIcon className="me-2 size-4" />
            {t("chat.uploadImage")}
            <FeatureBadge name="ai_image" className="ms-auto ps-2" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ms-auto flex items-center gap-1.5">
        {panel && (
          <span className="animate-pulse text-xs font-bold text-muted-foreground">
            {composer.busy ? t("chat.streaming") : ""}
          </span>
        )}
        {panel && (
          <LangMicGroup
            listening={composer.listening}
            onToggle={composer.toggleMic}
            disabled={!composer.canChat}
          />
        )}
        {composer.busy ? (
          // Mid-reply the Send button morphs into Stop, which aborts the stream
          // (partial reply stays put). Same slot in both layouts.
          <Button
            type="button"
            onClick={composer.stop}
            variant="secondary"
            size="sm"
            className="pointer-events-auto gap-1.5"
            title={t("chat.stop")}
          >
            <span className="hidden sm:inline">{t("chat.stop")}</span>
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          // Without AI chat (no model configured) Send stays, disabled.
          <Button
            type="button"
            onClick={composer.submit}
            disabled={!composer.canChat || !composer.canSend}
            size="sm"
            className="pointer-events-auto gap-1.5"
          >
            <span className="hidden sm:inline">{t("chat.send")}</span>
            <BicepsFlexed className="size-3.5 -scale-x-100" />
          </Button>
        )}
      </div>
    </>
  );

  return (
    <div
      className={cn(
        "space-y-2",
        panel
          ? "border-t bg-background/80 p-3 backdrop-blur-sm supports-backdrop-filter:bg-background/60 sm:p-4"
          : "px-2 pb-2",
      )}
    >
      {composer.pending.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-md border bg-muted p-2">
          {composer.pending.map((p) => (
            <div
              key={p.id}
              className="relative size-16 overflow-hidden rounded-sm border bg-background"
              title={p.name}
            >
              <img src={p.previewUrl} alt={p.name} className="size-full object-cover" />
              <button
                type="button"
                onClick={() => composer.removePending(p.id)}
                aria-label={t("chat.removeImage", { name: p.name })}
                className="absolute inset-e-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {composer.attachErr && <p className="text-xs text-destructive">{composer.attachErr}</p>}
      {composer.micError && (
        <p className="text-xs text-destructive">
          {t("chat.micError", { error: composer.micError })}
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_IMAGE_MIME.join(",")}
        multiple
        className="hidden"
        onChange={(e) => {
          void composer.ingestFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Both variants overlay the controls inside the textarea box (attach on
          the left, send on the right) — the mobile bar matches the desktop
          input. pb-12 reserves room for the control row. */}
      <div className="relative">
        <Textarea
          ref={composer.textareaRef}
          placeholder={composer.canChat ? t("chat.inputPlaceholder") : undefined}
          disabled={!composer.canChat}
          defaultValue=""
          rows={2}
          className={cn("min-h-24 pb-12", panel ? "resize-y" : "resize-none")}
          onChange={composer.onTextareaChange}
          onKeyDown={composer.onKeyDown}
        />
        {/* No AI chat (no model configured): the input is disabled and says
            why, with the lock badge, where the placeholder would be. */}
        {!composer.canChat && (
          <div className="pointer-events-none absolute inset-x-3 top-2.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {/* Some locales start lowercase (it's also used as a tooltip). */}
            <span className="inline-block first-letter:uppercase">{t("chat.chatUnavailable")}</span>
            <FeatureBadge name="ai_chat" />
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-1.5">
          {controls}
        </div>
      </div>

      {cameraOpen && (
        <CameraModal
          onClose={() => setCameraOpen(false)}
          onCapture={(blob) => {
            const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
            const dt = new DataTransfer();
            dt.items.add(file);
            void composer.ingestFiles(dt.files);
            setCameraOpen(false);
          }}
        />
      )}
    </div>
  );
}
