import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { ItemDetail, Location, OverlayState } from "../types";
import { useScannerListener } from "./useScannerListener";
import { ItemOverlay } from "../components/ItemOverlay";
import { ScanFab } from "./ScanFab";
import { RfidReaderControl } from "./RfidReaderControl";

// The camera scanner pulls in a large decoding library, so it loads only when
// someone actually opens the camera.
const CameraScanner = lazy(() =>
  import("./CameraScanner").then((m) => ({ default: m.CameraScanner })),
);

type ScanContextValue = {
  scan: (code: string) => void;
  openCamera: () => void;
  /** Send the next scan to `handler` instead of opening it. Null cancels. */
  armCapture: (handler: ((code: string) => void) | null) => void;
  /** Send every scan to `handler` until cancelled with null, as verifying does. */
  armBulkCapture: (handler: ((code: string) => void) | null) => void;
  /** While on, reads from the networked reader bridge feed `scan` as well. */
  rfidEnabled: boolean;
  setRfidEnabled: (on: boolean) => void;
  rfidReaderId: string;
  setRfidReaderId: (id: string) => void;
};

const ScanContext = createContext<ScanContextValue | null>(null);

export function useScan(): ScanContextValue {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error("useScan must be used within ScanProvider");
  return ctx;
}

const RFID_ENABLED_KEY = "bindex.rfid.enabled";
const RFID_READER_KEY = "bindex.rfid.reader";
// Fast enough that a read feels immediate without hammering the server.
const RFID_POLL_MS = 350;

/**
 * Scanning, for the whole app. A handheld reader on any screen, the camera, or
 * a networked reader all end up in `scan`, which resolves the code and opens an
 * overlay over whatever route you were on. A known code shows the record; an
 * unknown one opens a create form, filled in where the code could be looked up.
 */
export function ScanProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<OverlayState>({ kind: "closed" });
  const [camera, setCamera] = useState(false);
  const [researching, setResearching] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  // Only offer the camera scanner on touch devices (phones/tablets). On desktop
  // a handheld reader (e.g. Zebra DS2278) is used, captured globally below, so no
  // button needed, and no confusing webcam prompt.
  const [showCameraButton] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches,
  );

  const captureRef = useRef<((code: string) => void) | null>(null);
  const armCapture = useCallback((handler: ((code: string) => void) | null) => {
    captureRef.current = handler;
  }, []);
  const bulkRef = useRef<((code: string) => void) | null>(null);
  const armBulkCapture = useCallback((handler: ((code: string) => void) | null) => {
    bulkRef.current = handler;
  }, []);

  // Background product lookup runs after the create form is already open, so a
  // slow web search never blocks. `enrichToken` invalidates a stale/cancelled run.
  const enrichToken = useRef(0);
  const skipEnrich = useCallback(() => {
    enrichToken.current += 1; // ignore any in-flight result
    setState((s) => (s.kind === "create" ? { ...s, enriching: false } : s));
  }, []);

  const scan = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    // One-shot capture (e.g. "tag this item with the next scan") pre-empts lookup.
    if (captureRef.current) {
      const handler = captureRef.current;
      captureRef.current = null;
      setCamera(false);
      handler(code);
      return;
    }
    // Bulk capture (e.g. verifying a tote's contents) collects every read.
    if (bulkRef.current) {
      bulkRef.current(code);
      return;
    }
    setCamera(false);
    // A scanned QR may be a deep link to an item page, so go straight there.
    const deepLink = code.match(/\/items\/([0-9a-fA-F-]{36})(?:[/?#]|$)/);
    if (deepLink) {
      navigate(`/items/${deepLink[1]}`);
      return;
    }
    setState({ kind: "loading", code });
    api.listLocations().then(setLocations).catch(() => undefined);
    let found = false;
    try {
      const res = await api.scan(code);
      if (res.found && res.item) {
        setState({ kind: "found", item: res.item });
        found = true;
      } else {
        // Open the create form immediately; enrich in the background.
        setState({ kind: "create", code, enriching: true });
      }
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Scan failed" });
      return;
    }
    if (found) return;

    const token = ++enrichToken.current;
    try {
      const enrichment = await api.enrich(code);
      if (enrichToken.current !== token) return; // cancelled or superseded
      setState((s) =>
        s.kind === "create" && s.code === code
          ? { ...s, enrichment, enriching: false, rev: (s.rev ?? 0) + 1 }
          : s,
      );
    } catch {
      if (enrichToken.current !== token) return;
      setState((s) => (s.kind === "create" && s.code === code ? { ...s, enriching: false } : s));
    }
  }, [navigate]);

  // Reader input is listened for on every route, not just a search screen.
  useScannerListener(scan, true);

  // --- Networked reader ------------------------------------------------------
  // Poll the reader's channel and push every new tag through the same path a
  // handheld scanner uses, so it drives lookups, tagging and audits alike.
  const [rfidEnabled, setRfidEnabledState] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(RFID_ENABLED_KEY) === "1",
  );
  const [rfidReaderId, setRfidReaderIdState] = useState(
    () => (typeof localStorage !== "undefined" && localStorage.getItem(RFID_READER_KEY)) || "pico-1",
  );
  const setRfidEnabled = useCallback((on: boolean) => {
    setRfidEnabledState(on);
    try {
      localStorage.setItem(RFID_ENABLED_KEY, on ? "1" : "0");
    } catch {
      // Private browsing blocks writes; the setting just will not persist.
    }
  }, []);
  const setRfidReaderId = useCallback((id: string) => {
    setRfidReaderIdState(id);
    try {
      localStorage.setItem(RFID_READER_KEY, id);
    } catch {
      // As above: not persisting is survivable.
    }
  }, []);

  const scanRef = useRef(scan);
  scanRef.current = scan;
  useEffect(() => {
    if (!rfidEnabled || !rfidReaderId) return;
    let stopped = false;
    let since = 0;
    const tick = async () => {
      try {
        const r = await api.auditLive(rfidReaderId, since);
        // Following the server's sequence means a cleared channel, which resets
        // it to zero, recovers on the next poll instead of stalling.
        since = r.seq;
        for (const c of r.codes) scanRef.current(c);
      } catch {
        // A blip; the next tick picks up whatever was missed.
      }
    };
    const t = setInterval(() => {
      if (!stopped) void tick();
    }, RFID_POLL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [rfidEnabled, rfidReaderId]);

  // Look the product up again with a corrected search term, skipping the cache.
  // The originally scanned code is kept, because that is what gets saved.
  const research = useCallback(async (term: string) => {
    const t = term.trim();
    if (!t) return;
    enrichToken.current += 1; // supersede any background lookup
    setResearching(true);
    try {
      const enrichment = await api.enrich(t, true);
      setState((s) =>
        s.kind === "create" ? { ...s, enrichment, enriching: false, rev: (s.rev ?? 0) + 1 } : s,
      );
    } finally {
      setResearching(false);
    }
  }, []);

  // Throw away a wrong guess and type it in by hand. Any lookup still running
  // is cancelled too, so it cannot refill the form underneath you.
  const manualEntry = useCallback(() => {
    enrichToken.current += 1;
    setState((s) =>
      s.kind === "create"
        ? { ...s, enrichment: undefined, enriching: false, rev: (s.rev ?? 0) + 1 }
        : s,
    );
  }, []);

  const close = useCallback(() => {
    enrichToken.current += 1; // cancel any background lookup
    setState({ kind: "closed" });
  }, []);
  const onSaved = useCallback((item: ItemDetail) => setState({ kind: "found", item }), []);
  const onViewFull = useCallback(
    (id: string, unitId?: string | null) => {
      setState({ kind: "closed" });
      navigate(`/items/${id}${unitId ? `?unit=${unitId}` : ""}`);
    },
    [navigate],
  );

  return (
    <ScanContext.Provider
      value={{
        scan,
        openCamera: () => setCamera(true),
        armCapture,
        armBulkCapture,
        rfidEnabled,
        setRfidEnabled,
        rfidReaderId,
        setRfidReaderId,
      }}
    >
      {children}
      {showCameraButton && <ScanFab onClick={() => setCamera(true)} />}
      <RfidReaderControl
        enabled={rfidEnabled}
        readerId={rfidReaderId}
        onEnabledChange={setRfidEnabled}
        onReaderIdChange={setRfidReaderId}
      />
      {camera && (
        <Suspense fallback={null}>
          <CameraScanner onScan={scan} onClose={() => setCamera(false)} />
        </Suspense>
      )}
      <ItemOverlay
        state={state}
        locations={locations}
        researching={researching}
        onResearch={research}
        onManual={manualEntry}
        onSkipEnrich={skipEnrich}
        onClose={close}
        onSaved={onSaved}
        onViewFull={onViewFull}
      />
    </ScanContext.Provider>
  );
}
