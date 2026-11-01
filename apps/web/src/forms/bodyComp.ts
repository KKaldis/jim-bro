import i18n from "../i18n";

// Body-composition field logic shared between the manual Body-page form
// (Body.tsx LogEntryDialog) and the generic gate-form override for the
// `log_body_comp` tool (overrides.tsx). Keeping the rules here means
// "method-first, conditional inputs" is defined ONCE — both surfaces agree on
// which fields are relevant for a given measurement method + sex.

export type Sex = "male" | "female";

// The body_fat_method enum, mirrored from packages/shared BodyFatMethod. The
// UI treats this as the method-first selector: pick how you measured first,
// then only the relevant inputs render.
export const BODY_FAT_METHODS = [
  "dexa",
  "bia_scale",
  "caliper",
  "visual_estimate",
  "navy",
  "other",
] as const;

export type BodyFatMethod = (typeof BODY_FAT_METHODS)[number];

// Friendly labels for the method dropdown (parallel to BODY_FAT_METHODS).
// Kept as an English fallback used where the schema's agent-facing x-enumLabels
// are built (overrides.tsx); user-facing UI should call bodyFatMethodLabel().
export const BODY_FAT_METHOD_LABELS: Record<BodyFatMethod, string> = {
  dexa: "DEXA",
  bia_scale: "BIA scale",
  caliper: "caliper",
  visual_estimate: "visual estimate",
  navy: "Navy (tape measure)",
  other: "other",
};

// Localized label for the method dropdown, shown to the user.
export function bodyFatMethodLabel(method: BodyFatMethod): string {
  return i18n.t(`forms.bodyComp.methods.${method}`);
}

// "navy" derives BF% from circumferences; every other method is a direct
// reading the user types in.
export function isNavyMethod(method: string | null | undefined): boolean {
  return method === "navy";
}

function isDirectReadingMethod(method: string | null | undefined): boolean {
  return (
    method != null &&
    method !== "" &&
    method !== "navy" &&
    (BODY_FAT_METHODS as readonly string[]).includes(method)
  );
}

// Which body-comp inputs are relevant given the chosen method + the user's
// sex. weight + method + notes are always shown elsewhere; this covers the
// conditional middle.
//
//   - no method picked        → nothing yet (method-first: choose how first)
//   - direct reading method   → body_fat_pct
//   - navy                    → waist + neck (+ hip only for women)
//   - hip is never shown for non-female regardless of method
export function bodyCompFieldVisibility(
  method: string | null | undefined,
  sex: Sex | null | undefined,
): {
  bodyFatPct: boolean;
  waist: boolean;
  neck: boolean;
  hip: boolean;
} {
  const navy = isNavyMethod(method);
  const direct = isDirectReadingMethod(method);
  const female = sex === "female";
  return {
    bodyFatPct: direct,
    waist: navy,
    neck: navy,
    hip: navy && female,
  };
}
