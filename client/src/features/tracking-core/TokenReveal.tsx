import { useState } from "react";
import type { DeviceKind } from "./types";

/** Which endpoint a device of this kind would normally post to. */
function endpointFor(kind: DeviceKind): string {
  if (kind === "rfid_reader" || kind === "rfid_portal") return "/api/device/reads (or /reads/zebra, /reads/impinj)";
  return "/api/device/reads";
}

/**
 * A freshly issued device token. It is shown once, like an API key, because
 * only its hash is stored.
 */
export function TokenReveal({
  name,
  kind,
  token,
  onDismiss,
}: {
  name: string;
  kind: DeviceKind;
  token: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError("Could not copy. Select the token and copy it by hand.");
    }
  };

  return (
    <div className="rounded-lg border border-amber-700 bg-amber-950/50 p-4" role="status">
      <p className="text-sm font-medium text-amber-300">
        Ingest token for “{name}”. Copy it now; it is not shown again.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <code className="break-all rounded bg-slate-950 px-2 py-1 text-sm text-slate-200">{token}</code>
        <button
          onClick={copy}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={onDismiss} className="text-sm text-slate-400 hover:text-slate-200">
          Dismiss
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        The device sends it as <code className="text-slate-300">Authorization: Bearer &lt;token&gt;</code> when
        posting to <code className="text-slate-300">{endpointFor(kind)}</code>.
      </p>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
