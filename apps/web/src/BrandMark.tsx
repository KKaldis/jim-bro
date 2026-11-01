import { cn } from "./lib/utils";

// The logo + wordmark cluster, shared by the app header and the auth screens.
// Inherits the parent's flex direction (row in the header, column on auth
// screens).
const SIZES = {
  header: {
    icon: "h-8 w-8 sm:h-9 sm:w-9",
    text: "text-xl sm:text-2xl",
    full: "h-5 w-auto sm:h-6",
  },
  auth: {
    icon: "h-32 w-32 sm:h-40 sm:w-40",
    text: "text-3xl sm:text-4xl",
    full: "h-9 w-auto sm:h-11",
  },
} as const;

export function BrandMark({ variant }: { variant: "header" | "auth" }) {
  const s = SIZES[variant];

  // The white silhouette recolored per theme — inverted to black on
  // light backgrounds, left white on dark — with the wordmark alongside it.
  const Text = variant === "auth" ? "h1" : "span";
  return (
    <>
      <img src="/logo-2.svg" alt="" className={cn(s.icon, "invert dark:invert-0")} aria-hidden />
      <Text
        className={cn(
          "font-brand font-extrabold tracking-tight text-foreground italic dark:text-white",
          s.text,
        )}
      >
        Jim-Bro.ai
      </Text>
    </>
  );
}
