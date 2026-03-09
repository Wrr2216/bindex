import { useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useConfig } from "../config/useConfig";

/**
 * The print view: a bare page with no app chrome that loads a print-ready PDF
 * and opens the print dialog over it.
 *
 * Printing happens entirely on the visitor's own machine, to a printer attached
 * to it. The server never talks to a printer, so nothing about the printer is
 * configured here or there.
 *
 * The PDF has one exact-size page per label. That is deliberate: printing HTML
 * to a continuous label roll produces stray blank and oversized labels, whereas
 * one exact-size page produces one clean cut.
 *
 * Query parameters, all of which the server understands:
 *   ?id=     one item        ?ids=a,b,c    several items
 *   ?unit=   one unit        ?units=a,b,c  several units
 *   ?container=  an item as a container    ?location=  a location
 *   ?test=1  a sample label with no real record behind it
 *   &style=compact           the QR code alone, with the code beneath it
 */

type PrintJob = { pdfUrl: string | null; count: number; compact: boolean };

function resolveJob(params: URLSearchParams): PrintJob {
  const compact = params.get("style") === "compact";
  const none: PrintJob = { pdfUrl: null, count: 0, compact: false };

  if (params.get("test")) return { pdfUrl: api.samplePdfUrl(), count: 1, compact: false };

  const container = params.get("container");
  if (container) {
    return { pdfUrl: api.containerLabelPdfUrl(container), count: 1, compact: false };
  }

  const location = params.get("location");
  if (location) {
    return {
      pdfUrl: compact
        ? api.locationLabelCompactPdfUrl(location)
        : api.locationLabelPdfUrl(location),
      count: 1,
      compact,
    };
  }

  const unit = params.get("unit");
  if (unit) {
    return {
      pdfUrl: compact ? api.unitLabelCompactPdfUrl(unit) : api.unitLabelPdfUrl(unit),
      count: 1,
      compact,
    };
  }

  const unitIds = (params.get("units") ?? "").split(",").filter(Boolean);
  if (unitIds.length) {
    return { pdfUrl: api.unitLabelsPdfUrl(unitIds, compact), count: unitIds.length, compact };
  }

  const id = params.get("id");
  if (id) {
    return {
      pdfUrl: compact ? api.labelCompactPdfUrl(id) : api.labelPdfUrl(id),
      count: 1,
      compact,
    };
  }

  const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
  if (ids.length) return { pdfUrl: api.labelsPdfUrl(ids, compact), count: ids.length, compact };

  return none;
}

/**
 * A spreadsheet of the same labels, for label software that imports a data file
 * instead of printing a PDF. Null when the request does not name any records.
 */
function resolveSpreadsheet(params: URLSearchParams): string | null {
  if (params.get("test")) return api.sampleLabelSheetUrl();

  const container = params.get("container");
  if (container) return api.containerLabelSheetUrl(container);

  const location = params.get("location");
  if (location) return api.locationLabelSheetUrl(location);

  const unit = params.get("unit");
  if (unit) return api.unitLabelSheetUrl([unit]);

  const unitIds = (params.get("units") ?? "").split(",").filter(Boolean);
  if (unitIds.length) return api.unitLabelSheetUrl(unitIds);

  const id = params.get("id");
  if (id) return api.labelSheetUrl([id]);

  const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
  if (ids.length) return api.labelSheetUrl(ids);

  return null;
}

const page = {
  fontFamily: "system-ui, sans-serif",
  background: "#fff",
  color: "#0f172a",
};

const button = {
  border: 0,
  borderRadius: 8,
  padding: "8px 16px",
  fontSize: 14,
  cursor: "pointer",
};

export function PrintLabels() {
  const [params] = useSearchParams();
  const { config } = useConfig();
  const frame = useRef<HTMLIFrameElement>(null);

  const { pdfUrl, count, compact } = useMemo(() => resolveJob(params), [params]);
  const spreadsheetUrl = useMemo(() => resolveSpreadsheet(params), [params]);

  const openPrintDialog = () => {
    try {
      frame.current?.contentWindow?.focus();
      frame.current?.contentWindow?.print();
    } catch {
      // Some browsers refuse to drive a cross-document print. The button stays
      // available, and the PDF is visible and printable on its own.
    }
  };

  if (!pdfUrl) {
    return <p style={{ ...page, padding: 24 }}>Nothing to print.</p>;
  }

  // A compact label is square, at the width of the tape.
  const { widthMm, heightMm } = config.label;
  const size = compact ? `${widthMm} × ${widthMm} mm` : `${widthMm} × ${heightMm} mm`;

  return (
    <div style={{ ...page, display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid #e2e8f0" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <button
            onClick={openPrintDialog}
            style={{ ...button, background: "#0284c7", color: "#fff" }}
          >
            Print {count} label{count === 1 ? "" : "s"}
          </button>
          {spreadsheetUrl && (
            <a
              href={spreadsheetUrl}
              style={{
                ...button,
                background: "#f1f5f9",
                border: "1px solid #cbd5e1",
                color: "#334155",
                textDecoration: "none",
              }}
            >
              Download as a spreadsheet
            </a>
          )}
          <button
            onClick={() => window.close()}
            style={{ ...button, background: "#f1f5f9", border: "1px solid #cbd5e1", color: "#334155" }}
          >
            Close
          </button>
        </div>
        <p style={{ color: "#475569", fontSize: 13, marginTop: 8, maxWidth: 680 }}>
          Every page is exactly <strong>{size}</strong>. In the print dialog set the paper size to
          the roll you loaded, or add a custom size of the same dimensions with zero margins, and
          set the scale to <strong>100%</strong>. A scale of Fit or Default stretches the label and
          breaks the barcode. If pages come out rotated, set{" "}
          <code>LABEL_ROTATE_DEG</code> on the server.
        </p>
      </div>

      <iframe
        ref={frame}
        title="Labels ready to print"
        src={pdfUrl}
        // The embedded viewer needs a moment to lay the page out; printing the
        // instant it loads produces a blank sheet in several browsers.
        onLoad={() => setTimeout(openPrintDialog, 400)}
        style={{ flex: 1, border: 0, width: "100%" }}
      />
    </div>
  );
}
