import { useEffect } from "react";

/**
 * Notices a handheld reader typing anywhere on the page.
 *
 * A reader presents itself as a keyboard and types the code far faster than a
 * person can. A burst of at least MIN_LEN characters, all arriving quickly,
 * counts as a scan. It fires on Enter or on a short pause, so it works whether
 * or not the reader is configured to send a carriage return.
 *
 * The speed check is the whole trick: it is what stops ordinary typing, in the
 * search box or anywhere else, from being read as a scan.
 */
export function useScannerListener(onScan: (code: string) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const MIN_LEN = 3;
    const FAST_MS = 50; // max gap between keys to count as a machine burst
    const IDLE_MS = 90; // flush the buffer as a scan after this much idle

    let buffer = "";
    let last = 0;
    let allFast = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = () => {
      buffer = "";
      allFast = true;
    };

    const fire = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const code = buffer;
      const isScan = code.length >= MIN_LEN && allFast;
      reset();
      if (isScan) onScan(code);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        if (buffer.length >= MIN_LEN && allFast) {
          e.preventDefault(); // don't also submit the focused form
          fire();
        } else {
          reset();
        }
        return;
      }

      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;

      const now = performance.now();
      const gap = now - last;
      if (gap > IDLE_MS) reset(); // a new, slow burst starts fresh
      else if (gap > FAST_MS) allFast = false; // too slow to be a scanner
      buffer += e.key;
      last = now;

      // Fire shortly after the burst stops, for readers that send no Enter.
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, IDLE_MS);
    };

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (timer) clearTimeout(timer);
    };
  }, [onScan, enabled]);
}
