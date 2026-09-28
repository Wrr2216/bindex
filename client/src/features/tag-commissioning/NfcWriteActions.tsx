import { useState } from "react";
import { NFC_HINT, nfc, nfcCanLock, nfcSupported } from "./webnfc";

/**
 * Write a record's URL onto an NFC tag from the phone, so tapping the tag
 * opens the record anywhere. Optionally lock the tag afterwards, which cannot
 * be undone, so it asks first.
 */
export function NfcWriteActions({ url }: { url: string }) {
  const [lock, setLock] = useState(false);
  const [status, setStatus] = useState<"idle" | "waiting" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!nfcSupported) return <p className="mt-2 text-xs text-slate-500">{NFC_HINT}</p>;

  const write = async () => {
    if (
      lock &&
      !confirm("Make the tag read-only after writing? It can never be rewritten or erased, by anyone.")
    ) {
      return;
    }
    setStatus("waiting");
    setMessage(null);
    try {
      await nfc.write(url, { readOnly: lock });
      setStatus("done");
      setMessage(lock ? "Written and locked." : "Written. Tap it to check.");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Writing failed.");
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button
        onClick={write}
        disabled={status === "waiting"}
        className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {status === "waiting" ? "Hold a tag to the phone…" : "Write to a tag"}
      </button>
      {nfcCanLock && (
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
          Make read-only
        </label>
      )}
      {message && (
        <span className={`text-sm ${status === "error" ? "text-red-400" : "text-emerald-400"}`}>{message}</span>
      )}
    </div>
  );
}
