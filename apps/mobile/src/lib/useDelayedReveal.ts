import { useEffect, useRef, useState } from "react";

/**
 * Holds a non-null value back until it has been present for `delayMs`, then
 * reveals it; a value that disappears within the window never shows at all,
 * and once shown it hides the moment the value goes away — no exit delay for
 * a state that resolved. A label change while waiting does not restart the
 * window. Used to stop brief, self-cancelling states — a sync that resolves
 * in a few hundred milliseconds — from flashing the UI.
 */
export function useDelayedReveal<A>(value: A | null, delayMs: number): A | null {
  const [revealed, setRevealed] = useState<A | null>(null);
  const latestRef = useRef<A | null>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (value !== null) {
    latestRef.current = value;
  }

  const present = value !== null;

  // While present but not yet revealed, start a one-shot reveal timer. Keyed
  // on presence rather than the value itself, so the window measures the
  // state as a whole and a loading → syncing label change does not restart it.
  useEffect(() => {
    if (!present || revealed !== null || timerRef.current !== null) {
      return;
    }
    const timer = setTimeout(() => {
      timerRef.current = null;
      setRevealed(latestRef.current);
    }, delayMs);
    timerRef.current = timer;
    return () => {
      if (timerRef.current === timer) {
        clearTimeout(timer);
        timerRef.current = null;
      }
    };
  }, [delayMs, present, revealed]);

  // Once revealed, track the latest present value so the label stays fresh;
  // the moment the value goes away, cancel any pending reveal and hide at once.
  useEffect(() => {
    if (!present) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setRevealed(null);
      return;
    }
    if (revealed !== null) {
      setRevealed(value);
    }
  }, [present, revealed, value]);

  return revealed;
}
