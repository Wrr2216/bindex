import { useMemo, useState, type CSSProperties } from "react";
import { useFeatures } from "../../config/useConfig";
import { tagsApi } from "./api";

/**
 * "Print and encode" on the print view: the same labels as ZPL for a Zebra
 * RFID printer, which writes each record's EPC while it prints, or as a
 * code,EPC spreadsheet for other encoders. Printing through the browser stays
 * the main path; this is an extra download.
 *
 * Reads the same query parameters as the print view. Locations have no EPC,
 * so a location label offers nothing here.
 */

type Target = { itemIds: string[]; unitIds: string[]; sample: boolean };

function targetFrom(params: URLSearchParams): Target | null {
  const list = (key: string) => (params.get(key) ?? "").split(",").filter(Boolean);
  if (params.get("test")) return { itemIds: [], unitIds: [], sample: true };
  if (params.get("location")) return null;
  const itemIds = [params.get("container"), params.get("id"), ...list("ids")].filter((v): v is string => !!v);
  const unitIds = [params.get("unit"), ...list("units")].filter((v): v is string => !!v);
  if (!itemIds.length && !unitIds.length) return null;
  return { itemIds, unitIds, sample: false };
}

const box: CSSProperties = {
  marginTop: 10,
  padding: "10px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#f8fafc",
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  fontSize: 13,
  color: "#334155",
};
const button: CSSProperties = {
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
  background: "#fff",
  color: "#334155",
};

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function EncodeDownloads({ params }: { params: URLSearchParams }) {
  const features = useFeatures();
  const target = useMemo(() => targetFrom(params), [params]);
  const [dpi, setDpi] = useState(203);
  const [bind, setBind] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!features.printing || !target) return null;

  const run = async (format: "zpl" | "csv") => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const file = await tagsApi.encode({ ...target, format, dpi, bind: bind && !target.sample });
      download(file.blob, file.filename);
      setMessage(
        `${file.count} label${file.count === 1 ? "" : "s"}` +
          (file.bound ? `, ${file.bound} EPC${file.bound === 1 ? "" : "s"} recorded as RFID tags.` : "."),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={box}>
      <strong style={{ color: "#0f172a" }}>Print and encode (RFID)</strong>
      <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        Printer
        <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} style={{ ...button, padding: "4px 6px" }}>
          <option value={203}>203 dpi</option>
          <option value={300}>300 dpi</option>
          <option value={600}>600 dpi</option>
        </select>
      </label>
      <button onClick={() => void run("zpl")} disabled={busy} style={button}>
        Download ZPL
      </button>
      <button onClick={() => void run("csv")} disabled={busy} style={button}>
        Download code,EPC CSV
      </button>
      {!target.sample && (
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={bind} onChange={(e) => setBind(e.target.checked)} />
          Record the EPCs as these records' RFID tags
        </label>
      )}
      {message && <span style={{ color: "#047857" }}>{message}</span>}
      {error && <span style={{ color: "#b91c1c" }}>{error}</span>}
      <span style={{ flexBasis: "100%", color: "#64748b", fontSize: 12 }}>
        For Zebra ZT411R, ZT421R, ZD621R and similar: send the ZPL file to the printer (Zebra Setup
        Utilities, or copy it to the printer&apos;s port). It prints the same label and writes the EPC
        shown on each record&apos;s page.
      </span>
    </div>
  );
}
