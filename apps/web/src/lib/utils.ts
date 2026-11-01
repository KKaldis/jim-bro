import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge the theme's elevation scale (styles.css), so e.g.
// cn("shadow-surface", "shadow-none") resolves to one shadow instead of the
// custom name being mistaken for a shadow color and both being kept.
// Also teach it v4's CSS-variable shorthand for sizes (w-(--x)), which
// tailwind-merge 2.x doesn't parse — otherwise cn("w-72", "w-(--x)") keeps both
// and the base width can win.
const isVarShorthand = (v: string) => /^\(--[\w-]+\)$/.test(v);
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [{ shadow: ["surface", "tile", "control", "pressed", "field", "well", "overlay"] }],
      w: [{ w: [isVarShorthand] }],
      h: [{ h: [isVarShorthand] }],
      "min-w": [{ "min-w": [isVarShorthand] }],
      "max-w": [{ "max-w": [isVarShorthand] }],
      "min-h": [{ "min-h": [isVarShorthand] }],
      "max-h": [{ "max-h": [isVarShorthand] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
