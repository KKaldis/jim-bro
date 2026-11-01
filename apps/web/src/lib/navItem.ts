// Shape shared by every nav item (header, bottom primary nav, section
// sub-navs), so the main and secondary navs read as one family in every style.
export const navItemBase =
  "rounded-lg font-medium transition-[color,background-color,box-shadow] soft:active:shadow-pressed brutal:active:translate-none";

// State classes shared by every nav item (header + bottom primary nav, section
// sub-navs), so a style restyles navigation in one place. Flat: the active
// item gets a primary tint. Soft: idle items sit raised and the active one is
// pressed into the bar, lit by the primary text instead of a tint. Pass
// hover="group" when the classes go on a child of the hovered element.
export function navItemClass(active: boolean, hover: "self" | "group" = "self"): string {
  if (active) {
    return "bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary soft:bg-background soft:shadow-pressed soft:hover:bg-background";
  }
  return hover === "group"
    ? "text-muted-foreground group-hover:bg-muted group-hover:text-foreground soft:shadow-control soft:group-hover:bg-background soft:group-hover:text-primary"
    : "text-muted-foreground hover:bg-muted hover:text-foreground soft:shadow-control soft:hover:bg-background soft:hover:text-primary";
}

// Nav bars in soft drop the hairline border for a shade cast onto the
// content, on a solid fill (translucent glass muddies the shadows).
export const navBarSoftTop =
  "soft:border-transparent soft:bg-background soft:shadow-[0_-8px_16px_-10px_var(--nm-shade)]";
export const navBarSoftBottom =
  "soft:border-transparent soft:bg-background soft:shadow-[0_8px_16px_-10px_var(--nm-shade)]";

// Selectable option pills / cards (formKit PillToggle and its look-alikes,
// the profile form's sex toggle and goal cards). Flat: a tinted fill with a
// colored outline. Soft: no outline or tint — the chosen one is simply
// pressed in and its text takes the tone color. Pass muted=false when the
// option renders its own text colors.
export function toggleItemClass(
  active: boolean,
  { tone = "primary", muted = true }: { tone?: "primary" | "warning"; muted?: boolean } = {},
): string {
  if (active) {
    return tone === "warning"
      ? "border-warning bg-warning/10 text-foreground shadow-pressed soft:border-transparent soft:bg-background soft:text-warning"
      : "border-primary bg-primary/10 text-foreground shadow-pressed soft:border-transparent soft:bg-background soft:text-primary";
  }
  return muted
    ? "border-edge bg-background/40 text-muted-foreground shadow-control hover:bg-accent"
    : "border-edge bg-background/40 shadow-control hover:bg-accent";
}
