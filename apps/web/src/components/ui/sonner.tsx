// App-wide toast host (Sonner), themed to the app's own light/dark resolution
// rather than next-themes. Mounted once at the App root. Positioned top-center
// so CRUD confirmations land in the same spot whether the user is on a data
// screen or the chat. See lib/toast.ts for the notify helpers that feed it.
import { Toaster as SonnerToaster } from "sonner";
import { useTheme } from "../../lib/theme";

export function Toaster() {
  const { resolved } = useTheme();
  return (
    <SonnerToaster
      theme={resolved}
      position="top-center"
      // Nudge the stack below the mobile header + the thinking/reset drawer's
      // peek handle (which shares the top edge over the data screens), so coach
      // toasts and CRUD confirmations don't collide with it.
      mobileOffset={{ top: "4.25rem" }}
      className="toaster group"
      // richColors gives success (green) / error (red) tints so CRUD outcomes
      // read at a glance. We source the text + outline from our own shadcn
      // tokens (--success / --destructive / --warning / --info) so each
      // variant's border carries its own semantic color rather than a flat
      // brand outline.
      richColors
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--info)",

          "--success-bg": "var(--popover)",
          "--success-text": "var(--success)",
          "--success-border": "var(--success)",

          "--error-bg": "var(--popover)",
          "--error-text": "var(--destructive)",
          "--error-border": "var(--destructive)",

          "--warning-bg": "var(--popover)",
          "--warning-text": "var(--warning)",
          "--warning-border": "var(--warning)",
        } as React.CSSProperties
      }
      toastOptions={{ className: "group toast" }}
    />
  );
}
