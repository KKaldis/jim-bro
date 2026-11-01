import { useEffect, useRef, useState } from "react";

// Keeps a loading flag truthy for at least `minMs` after it first flips on, so
// fast responses (typical on localhost) still show their skeleton long enough
// for the user to perceive. Without this, a sub-100ms fetch makes the loader
// flash imperceptibly and the UI looks like it never loaded.
export function useMinLoading(loading: boolean, minMs = 350): boolean {
  const [visible, setVisible] = useState(loading);
  const startedAtRef = useRef<number | null>(loading ? Date.now() : null);

  useEffect(() => {
    if (loading) {
      startedAtRef.current = Date.now();
      setVisible(true);
      return;
    }
    const start = startedAtRef.current;
    if (start == null) {
      setVisible(false);
      return;
    }
    const remaining = minMs - (Date.now() - start);
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(t);
  }, [loading, minMs]);

  return visible;
}
