import { useState } from "react";
import { NfcWriteActions } from "../features/tag-commissioning/NfcWriteActions";

/**
 * The URL to write onto an NFC tag for this record. Encode it as an NDEF URI
 * record with any tag writer, and tapping the tag with a phone opens this page.
 * The in-app scanner resolves the same URL, so one tag serves both.
 */
export function NfcTagUrl({ path, kind }: { path: string; kind: "item" | "location" }) {
  const url = `${window.location.origin}${path}`;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard API needs a secure context. Without one, the text is
      // still on screen to select by hand.
    }
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">NFC tag</h2>
      <p className="mb-2 text-xs text-slate-500">
        Encode this URL onto an NFC tag (NDEF URI record). Tapping the tag with a phone opens this{" "}
        {kind}.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-lg bg-slate-800/60 px-3 py-2 font-mono text-xs text-slate-300">
          {url}
        </code>
        <button
          onClick={copy}
          className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <NfcWriteActions url={url} />
    </section>
  );
}
