import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

/** Barcode scanning through the camera, for when there is no reader to hand. */
export function CameraScanner({
  onScan,
  onClose,
}: {
  onScan: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let controls: { stop: () => void } | undefined;
    let stopped = false;

    reader
      .decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
        if (result && !stopped) {
          stopped = true;
          onScan(result.getText());
        }
      })
      .then((c) => {
        controls = c;
        if (stopped) c.stop();
      })
      .catch((err) => setError(String(err?.message ?? err)));

    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90">
      <div className="flex items-center justify-between p-4">
        <span className="text-sm text-slate-300">Point the camera at a barcode</span>
        <button
          onClick={onClose}
          className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700"
        >
          Cancel
        </button>
      </div>
      <div className="relative flex-1">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-40 w-72 rounded-xl border-2 border-sky-400/80" />
        </div>
      </div>
      {error && (
        <p className="bg-red-950/80 p-3 text-center text-sm text-red-200">
          Camera unavailable: {error}
        </p>
      )}
    </div>
  );
}
