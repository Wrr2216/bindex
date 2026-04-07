import { useState } from "react";

/**
 * Corner control for a networked tag reader fed by the bridge. It sits in a
 * fixed pill so the reader can be turned on and its channel set from any page.
 * While it is on, its reads drive the same scanner path as a handheld one.
 */
export function RfidReaderControl({
  enabled,
  readerId,
  onEnabledChange,
  onReaderIdChange,
}: {
  enabled: boolean;
  readerId: string;
  onEnabledChange: (on: boolean) => void;
  onReaderIdChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed bottom-4 left-4 z-40 print:hidden">
      {open && (
        <div className="mb-2 w-60 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
          <label className="flex items-center justify-between gap-2 text-sm text-slate-200">
            <span>RFID reader</span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
              className="h-4 w-4"
            />
          </label>
          <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-slate-400">
            Reader channel
          </label>
          <input
            value={readerId}
            onChange={(e) => onReaderIdChange(e.target.value.trim())}
            placeholder="pico-1"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
          <p className="mt-2 text-xs text-slate-500">
            Must match the bridge&rsquo;s <span className="font-mono">READER_ID</span>. When on, the
            reader scans on every page.
          </p>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium shadow-lg transition ${
          enabled
            ? "border-emerald-600 bg-emerald-600/90 text-white hover:bg-emerald-500"
            : "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
        }`}
        title="Hardware RFID reader"
      >
        <span className={`h-2 w-2 rounded-full ${enabled ? "animate-pulse bg-white" : "bg-slate-500"}`} />
        Tag reader {enabled ? "on" : "off"}
      </button>
    </div>
  );
}
