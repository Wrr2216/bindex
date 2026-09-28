import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Web NFC: reading and writing NDEF tags from the browser. Only Chrome on
 * Android implements it, so everything here is feature-detected and the
 * interface hides NFC controls elsewhere.
 *
 * One reader scans for the whole app. Whoever wants the next tap pushes a
 * handler and the newest one gets it (binding a tag, a bulk session); when
 * nobody has, the tap goes to the fallback, which looks the tag up.
 */

// The Web NFC API is not in TypeScript's DOM library yet.
interface NdefRecord {
  recordType: string;
  mediaType?: string;
  encoding?: string;
  data?: DataView;
  toRecords?: () => NdefRecord[];
}
interface NdefReadingEvent extends Event {
  serialNumber: string;
  message: { records: NdefRecord[] };
}
interface NdefReader extends EventTarget {
  onreading: ((ev: NdefReadingEvent) => void) | null;
  onreadingerror: ((ev: Event) => void) | null;
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(
    message: { records: { recordType: string; data: string }[] },
    options?: { overwrite?: boolean; signal?: AbortSignal },
  ): Promise<void>;
  makeReadOnly?(options?: { signal?: AbortSignal }): Promise<void>;
}
type NdefReaderConstructor = new () => NdefReader;

const Reader: NdefReaderConstructor | null =
  typeof window !== "undefined" && "NDEFReader" in window
    ? ((window as unknown as { NDEFReader: NdefReaderConstructor }).NDEFReader)
    : null;

export const nfcSupported = Reader !== null;

/** Whether this browser can make a tag read-only (Chrome 100 and later). */
export const nfcCanLock =
  Reader !== null && typeof (Reader.prototype as NdefReader).makeReadOnly === "function";

/** One-line explanation shown where NFC controls would otherwise be. */
export const NFC_HINT = "Tapping and writing NFC tags works in Chrome on Android.";

export type NfcTap = {
  /** The tag's UID as bare uppercase hex, or "" when the tag does not report one. */
  uid: string;
  /** The first URL record on the tag, if any. */
  url: string | null;
};

export type NfcHandler = (tap: NfcTap) => void;

type Status = "off" | "starting" | "on" | "error";
export type NfcState = { status: Status; error: string | null; writing: boolean };

let state: NfcState = { status: "off", error: null, writing: false };
const listeners = new Set<() => void>();
const handlers: NfcHandler[] = [];
let fallback: NfcHandler | null = null;
let reader: NdefReader | null = null;
let abort: AbortController | null = null;
// Reads that arrive while a write is under way, or just after, are the tag
// being written. Dispatching them would bind or open the wrong thing.
let quietUntil = 0;

function set(next: Partial<NfcState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function decode(record: NdefRecord): string | null {
  if (!record.data) return null;
  try {
    return new TextDecoder(record.encoding || "utf-8").decode(record.data);
  } catch {
    return null;
  }
}

function findUrl(records: NdefRecord[]): string | null {
  for (const r of records) {
    if (r.recordType === "url" || r.recordType === "absolute-url") {
      const url = decode(r);
      if (url) return url;
    }
    // A smart poster wraps its URL in nested records.
    if (r.recordType === "smart-poster" && r.toRecords) {
      const nested = findUrl(r.toRecords());
      if (nested) return nested;
    }
  }
  return null;
}

export const normalizeUid = (serial: string) => serial.replace(/[^0-9a-fA-F]/g, "").toUpperCase();

function dispatch(ev: NdefReadingEvent): void {
  if (Date.now() < quietUntil || state.writing) return;
  let url: string | null = null;
  try {
    url = findUrl(ev.message?.records ?? []);
  } catch {
    // An unreadable message still has a UID worth looking up.
  }
  const tap: NfcTap = { uid: normalizeUid(ev.serialNumber ?? ""), url };
  const handler = handlers[handlers.length - 1] ?? fallback;
  handler?.(tap);
}

function describe(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError") return "NFC permission was refused. Allow it in the site settings.";
  if (name === "NotSupportedError") return "This phone has no NFC, or NFC is switched off.";
  if (name === "AbortError") return "Stopped.";
  if (name === "NetworkError") return "The tag moved away before it was done. Hold it still and try again.";
  return err instanceof Error ? err.message : "NFC failed.";
}

export const nfc = {
  /** Start listening for taps. Call from a click the first time: Chrome asks for permission. */
  async start(): Promise<boolean> {
    if (!Reader) return false;
    if (state.status === "on" || state.status === "starting") return true;
    set({ status: "starting", error: null });
    try {
      reader = new Reader();
      abort = new AbortController();
      reader.onreading = dispatch;
      reader.onreadingerror = () => set({ error: "That tag could not be read. Try again." });
      await reader.scan({ signal: abort.signal });
      set({ status: "on" });
      return true;
    } catch (err) {
      reader = null;
      abort = null;
      set({ status: "error", error: describe(err) });
      return false;
    }
  },

  stop(): void {
    abort?.abort();
    abort = null;
    reader = null;
    set({ status: "off", error: null });
  },

  /** Take the next taps until the returned function is called. */
  push(handler: NfcHandler): () => void {
    handlers.push(handler);
    return () => {
      const i = handlers.lastIndexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  },

  setFallback(handler: NfcHandler | null): void {
    fallback = handler;
  },

  /**
   * Write a URL record to the next tag tapped, and optionally make it
   * read-only while it is still against the phone.
   */
  async write(url: string, options: { readOnly?: boolean; timeoutMs?: number } = {}): Promise<void> {
    if (!Reader) throw new Error(NFC_HINT);
    const writer = new Reader();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 30_000);
    set({ writing: true, error: null });
    try {
      await writer.write({ records: [{ recordType: "url", data: url }] }, { overwrite: true, signal: ctrl.signal });
      if (options.readOnly) {
        if (!writer.makeReadOnly) throw new Error("This browser cannot lock tags. The URL was written.");
        await writer.makeReadOnly({ signal: ctrl.signal });
      }
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        throw new Error("No tag was tapped in time. Try again.");
      }
      throw new Error(describe(err));
    } finally {
      clearTimeout(timer);
      quietUntil = Date.now() + 1500;
      set({ writing: false });
    }
  },

  getState: (): NfcState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useNfcState(): NfcState {
  return useSyncExternalStore(nfc.subscribe, nfc.getState, nfc.getState);
}

/**
 * Receive taps while the calling component is mounted and `active`. The
 * handler may change on every render; the latest one is used.
 */
export function useNfcTaps(active: boolean, handler: NfcHandler): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!active || !nfcSupported) return;
    return nfc.push((tap) => latest.current(tap));
  }, [active]);
}
