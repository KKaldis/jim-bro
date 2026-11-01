import { useMemo, useState } from "react";
import { type CustomRange, defaultCustomRange, type Granularity, rangeFor } from "../dateRange";

// Bundles the resolved {from,to,label} range with the custom-range state so
// every data screen wires RangeNav the same way. The custom range is local,
// transient state (last-week default) — it's only consulted while granularity
// is "custom", but kept alive across granularity switches so toggling away and
// back doesn't lose the user's picked span.
export function useDateRange(granularity: Granularity, anchor: Date) {
  const [customRange, setCustomRange] = useState<CustomRange>(defaultCustomRange);
  const range = useMemo(
    () => rangeFor(granularity, anchor, customRange),
    [granularity, anchor, customRange],
  );
  return { range, customRange, setCustomRange };
}
