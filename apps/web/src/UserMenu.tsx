import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BrickWall,
  Calculator,
  CircleHelp,
  Download,
  Gauge,
  Monitor,
  Moon,
  Palette,
  Settings as SettingsIcon,
  Share,
  Square,
  Squircle,
  Sun,
  LogOut,
} from "lucide-react";
import { signOut } from "./auth.ts";
import { UserAvatar } from "./avatars.tsx";
import { IosInstallHelp } from "./InstallToast.tsx";
import { Settings } from "./Settings.tsx";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { useInstallPrompt } from "./lib/pwa";
import { useTheme, type ThemePreference, type ThemeStyle } from "./lib/theme.tsx";
import { useUiStore } from "./lib/uiStore";

export function UserMenu({
  label,
  onProfileSaved,
  onOpenCalculators,
  onOpenUsage,
}: {
  label: string;
  onProfileSaved?: () => void;
  onOpenCalculators?: () => void;
  onOpenUsage?: () => void;
}) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [iosHelpOpen, setIosHelpOpen] = useState(false);
  const { theme, setTheme, resolved, style, setStyle } = useTheme();
  const { canInstall, installed, install, ios } = useInstallPrompt();
  const startTour = useUiStore((s) => s.startTour);
  // The app tour's last step can ask for the profile dialog, which lives here.
  const profileRequest = useUiStore((s) => s.profileRequest);
  useEffect(() => {
    if (profileRequest) setSettingsOpen(true);
  }, [profileRequest]);

  const ThemeIcon = resolved === "dark" ? Moon : Sun;
  // Hide entirely once installed; on iOS we always offer the manual flow
  // because there is no programmatic install signal.
  const showInstall = !installed && (canInstall || ios);

  const handleInstall = async () => {
    if (ios) {
      setIosHelpOpen(true);
      return;
    }
    await install();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full soft:shadow-control soft:hover:bg-background soft:data-[state=open]:shadow-pressed"
            aria-label={label}
            title={label}
            data-tour="menu"
          >
            <UserAvatar size={32} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex items-center gap-2 text-sm font-normal tracking-normal text-foreground normal-case">
            <UserAvatar size={28} />
            <span className="truncate">{label}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <SettingsIcon className="size-4" />
            {t("userMenu.userProfile")}
          </DropdownMenuItem>
          {onOpenUsage && (
            <DropdownMenuItem onSelect={onOpenUsage}>
              <Gauge className="size-4" />
              {t("nav.usage")}
            </DropdownMenuItem>
          )}
          {onOpenCalculators && (
            <DropdownMenuItem onSelect={onOpenCalculators}>
              <Calculator className="size-4" />
              {t("nav.calculators")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={startTour}>
            <CircleHelp className="size-4" />
            {t("tour.menuItem")}
          </DropdownMenuItem>
          {showInstall && (
            <DropdownMenuItem onSelect={handleInstall}>
              {ios ? <Share className="size-4" /> : <Download className="size-4" />}
              {t("userMenu.installApp")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            <span className="flex items-center gap-2">
              <ThemeIcon className="size-3.5" />
              {t("userMenu.theme")}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(v) => setTheme(v as ThemePreference)}
          >
            <DropdownMenuRadioItem value="light">
              <span className="flex items-center gap-2">
                <Sun className="size-4" />
                {t("userMenu.light")}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <span className="flex items-center gap-2">
                <Moon className="size-4" />
                {t("userMenu.dark")}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <span className="flex items-center gap-2">
                <Monitor className="size-4" />
                {t("userMenu.system")}
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            <span className="flex items-center gap-2">
              <Palette className="size-3.5" />
              {t("userMenu.style")}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={style} onValueChange={(v) => setStyle(v as ThemeStyle)}>
            <DropdownMenuRadioItem value="flat">
              <span className="flex items-center gap-2">
                <Square className="size-4" />
                {t("userMenu.styleFlat")}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="soft">
              <span className="flex items-center gap-2">
                <Squircle className="size-4" />
                {t("userMenu.styleSoft")}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="brutal">
              <span className="flex items-center gap-2">
                <BrickWall className="size-4" />
                {t("userMenu.styleBrutal")}
              </span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => signOut()}>
            <LogOut className="size-4" />
            {t("userMenu.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            onProfileSaved?.();
            setSettingsOpen(false);
          }}
        />
      )}
      <IosInstallHelp open={iosHelpOpen} onOpenChange={setIosHelpOpen} />
    </>
  );
}
