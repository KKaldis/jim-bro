import { createContext, useContext } from "react";

import type { View } from "../lib/uiStore";

// Lets a chat result card jump the data screens to the day (and screen) the
// card is reporting on — e.g. clicking a past date on the macros card opens the
// Food view at that day so the user can see the full log. Provided by Chat,
// wired to its onSelectDate + onShowScreen props (the same plumbing the agent's
// view_date_hint / show_screen events use). Null outside chat, where cards
// render read-only and the day tag is plain text.
export type CardNav = {
  /** `tab` picks a sub-tab of the screen (e.g. body → "measurements"). */
  navigateToDate: (iso: string, screen: View, tab?: string) => void;
};

export const CardNavContext = createContext<CardNav | null>(null);

export function useCardNav(): CardNav | null {
  return useContext(CardNavContext);
}
