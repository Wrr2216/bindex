import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { EvidenceAttachment, EvidencePack, LineEvidence, Phase, TimelineEntry } from "./types";
import { CARD, H2, fmtDateTime } from "./ui";

/**
 * The evidence pack, read-only: what was already on file about each line when
 * the claim was opened, and everything since. Nothing here is attached by
 * hand; it comes from the manifest, the photos on the items, condition and
 * custody records when those features are installed, and the audit log.
 */

const PHASES: { phase: Phase; label: string }[] = [
  { phase: "before", label: "Before the move" },
  { phase: "during", label: "In transit" },
  { phase: "after", label: "After / on arrival" },
  { phase: "unknown", label: "Other" },
];

const SOURCE_LABEL = {
  stage: "Stage note",
  line: "Manifest note",
  condition_report: "Condition report",
  pack_list: "Pack list",
  photo: "Photo caption",
  custody: "Custody",
} as const;

function Photos({ files }: { files: EvidenceAttachment[] }) {
  const images = files.filter((f) => f.thumbUrl);
  const others = files.filter((f) => !f.thumbUrl);
  return (
    <div className="space-y-2">
      {images.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {images.map((f) => (
            <li key={f.id}>
              <a href={f.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
                <img src={`${f.thumbUrl}?w=320`} alt={f.caption ?? `Photo ${f.stage ?? ""}`} loading="lazy" className="aspect-square w-full object-cover" />
              </a>
              <p className="mt-1 text-[11px] leading-tight text-slate-400">
                {[f.stage, fmtDateTime(f.createdAt)].filter(Boolean).join(" · ")}
                {f.caption && <span className="block text-slate-300">{f.caption}</span>}
                {f.owner === "condition_report" && <span className="block text-sky-300">From a condition report</span>}
                {f.owner === "pack_list" && <span className="block text-sky-300">From the pack list</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="space-y-1 text-sm">
          {others.map((f) => (
            <li key={f.id}>
              <a href={f.url} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                {f.caption ?? `${f.kind} (${f.mime})`}
              </a>
              <span className="text-xs text-slate-500"> · {fmtDateTime(f.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LineEvidenceView({ line }: { line: LineEvidence }) {
  const t = line.trip;
  const steps = t
    ? [
        ["Packed", t.packedAt],
        ["Loaded", t.loadedAt],
        ["Delivered", t.deliveredAt],
        ["Placed", t.placedAt],
      ].filter((s): s is [string, string] => Boolean(s[1]))
    : [];
  const byPhase = PHASES.map((p) => ({ ...p, files: line.attachments.filter((a) => a.phase === p.phase) })).filter((p) => p.files.length);

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Trip</h4>
        {t ? (
          <p className="text-slate-300">
            {line.jobCode && <span className="font-mono text-xs text-slate-400">{line.jobCode} </span>}
            {steps.map(([label, at]) => `${label} ${fmtDateTime(at)}`).join(" · ") || "No stage changes yet"}
            {t.exceptions.map((x) => (
              <span key={x.at} className="ml-2 text-red-300">
                {x.stage.replace(/_/g, " ")} {fmtDateTime(x.at)}
              </span>
            ))}
          </p>
        ) : (
          <p className="text-slate-500">{line.jobItemId ? "No stage changes yet." : "Not on a job manifest, so there is no trip to show."}</p>
        )}
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Photos and files</h4>
        {byPhase.length === 0 && <p className="text-slate-500">None on file for this item yet.</p>}
        {byPhase.map((p) => (
          <div key={p.phase} className="mb-3">
            <p className="mb-1 text-xs text-slate-400">
              {p.label} ({p.files.length})
            </p>
            <Photos files={p.files} />
          </div>
        ))}
      </div>

      {line.conditionNotes.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Condition notes</h4>
          <ul className="space-y-1">
            {line.conditionNotes.map((n, i) => (
              <li key={`${n.ref}-${i}`} className="text-slate-200">
                <span className="text-xs text-slate-500">
                  {n.at ? fmtDateTime(n.at) : "On the manifest"} · {SOURCE_LABEL[n.source]}
                  {n.stage ? ` (${n.stage.replace(/_/g, " ")})` : ""}
                  {n.by ? ` · ${n.by}` : ""}
                </span>
                <span className="block">{n.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {line.conditionReports.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Condition reports</h4>
          <ul className="space-y-2">
            {line.conditionReports.map((r) => (
              <li key={r.id} className="rounded-lg bg-slate-800/50 p-2">
                <p className="text-slate-200">
                  <span className="font-medium">{r.stage ?? "Report"}</span>
                  {r.rating && <span> · {r.rating}</span>}
                  <span className="text-xs text-slate-500"> · {fmtDateTime(r.createdAt)}</span>
                </p>
                {r.notes && <p className="text-slate-300">{r.notes}</p>}
                {r.defects.length > 0 && (
                  <ul className="mt-1 list-inside list-disc text-xs text-slate-300">
                    {r.defects.map((d, i) => (
                      <li key={i}>{[d.severity, d.type, d.area && `on ${d.area}`, d.description].filter(Boolean).join(" ")}</li>
                    ))}
                  </ul>
                )}
                {r.handlingNote && <p className="text-xs text-amber-300">Handling: {r.handlingNote}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {line.packLists.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Pack list</h4>
          <ul className="space-y-2">
            {line.packLists.map((p) => (
              <li key={p.id} className="rounded-lg bg-slate-800/50 p-2">
                <p className="text-xs text-slate-500">
                  {fmtDateTime(p.createdAt)}
                  {p.sizeClass && ` · ${p.sizeClass}`}
                  {p.room && ` · for ${p.room}`}
                  {p.flags.length > 0 && ` · ${p.flags.join(", ").replace(/_/g, " ")}`}
                </p>
                {p.handwrittenText && <p className="text-slate-300">Marked “{p.handwrittenText}”</p>}
                {p.contents.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc text-xs text-slate-300">
                    {p.contents.map((c, i) => (
                      <li key={i}>
                        {c.qty && c.qty > 1 ? `${c.qty} × ` : ""}
                        {c.name}
                        {c.fragile ? " (fragile)" : ""}
                        {c.condition ? `, ${c.condition}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  p.contentsSummary && <p className="text-xs text-slate-300">{p.contentsSummary}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {line.custody.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Chain of custody</h4>
          <ol className="space-y-1">
            {line.custody.map((h) => (
              <li key={h.id} className="text-slate-200">
                <span className="text-xs text-slate-500">{fmtDateTime(h.at)} · </span>
                {h.from ?? "?"} → {h.to ?? "?"}
                {h.sealNumbers.length > 0 && <span className="text-xs text-slate-400"> · seals {h.sealNumbers.join(", ")}</span>}
                {h.signatures.length > 0 && (
                  <span className="text-xs text-emerald-300"> · signed by {h.signatures.map((s) => s.signerName).join(" and ")}</span>
                )}
                {h.conditionNote && <span className="block text-xs text-slate-300">{h.conditionNote}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {line.stageHistory.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Stage history</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Stage</th>
                  <th className="py-1 pr-3 font-medium">How and who</th>
                  <th className="py-1 font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {line.stageHistory.map((h) => (
                  <tr key={h.id}>
                    <td className="whitespace-nowrap py-1 pr-3">{fmtDateTime(h.at)}</td>
                    <td className="py-1 pr-3">{h.label}</td>
                    <td className="py-1 pr-3">{[h.via, h.actor, h.deviceId, h.shipmentCode].filter(Boolean).join(" · ")}</td>
                    <td className="py-1">{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {line.audit.length > 0 && (
        <details className="text-xs text-slate-400">
          <summary className="cursor-pointer">Audit log: {line.audit.length} entr{line.audit.length === 1 ? "y" : "ies"}</summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {line.audit.map((a) => (
              <li key={a.id}>
                #{a.id} {a.type} {fmtDateTime(a.occurredAt)} {a.hash.slice(0, 16)}…
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function EvidenceSummary({ pack }: { pack: EvidencePack }) {
  const photos = pack.lines.reduce((n, l) => n + l.attachments.length, 0);
  const notes = pack.lines.reduce((n, l) => n + l.conditionNotes.length, 0);
  return (
    <div className="space-y-1 text-xs text-slate-400">
      <p>
        {photos} photo{photos === 1 ? "" : "s"} and file{photos === 1 ? "" : "s"}, {notes} condition note{notes === 1 ? "" : "s"} gathered
        from the manifest, the {pack.lines.length === 1 ? "item" : "items"} and the audit log.
        {!pack.sources.conditionReports && " Condition reports and pack lists are not installed."}
        {!pack.sources.custody && " Chain of custody is not installed."}
      </p>
      <p className="break-all">
        Fingerprint <span className="font-mono">{pack.hash.slice(0, 16)}…</span>
        {pack.frozen &&
          (pack.unchangedSinceSubmission
            ? " · unchanged since submission"
            : ` · records added or removed since submission (then ${pack.frozen.hash.slice(0, 16)}…)`)}
      </p>
    </div>
  );
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(-12);
  if (!entries.length) return null;
  return (
    <section className={`${CARD} space-y-3`}>
      <div className="flex items-center justify-between">
        <h2 className={H2}>Timeline</h2>
        {entries.length > 12 && (
          <button onClick={() => setAll(!all)} className="text-xs text-sky-300 hover:underline">
            {all ? "Show the latest" : `Show all ${entries.length}`}
          </button>
        )}
      </div>
      <ol className="space-y-2 border-l border-slate-800 pl-4">
        {shown.map((e, i) => (
          <li key={`${e.at}-${i}`} className="relative text-sm">
            <span
              className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${
                e.kind === "claim" ? "bg-sky-400" : e.kind === "custody" ? "bg-emerald-400" : e.kind === "shipment" ? "bg-violet-400" : "bg-slate-500"
              }`}
            />
            <span className="text-xs text-slate-500">{fmtDateTime(e.at)}</span>
            <span className="block text-slate-200">{e.label}</span>
            {e.detail && <span className="block text-xs text-slate-400">{e.detail}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ItemLink({ itemId, children }: { itemId: string | null; children: ReactNode }) {
  if (!itemId) return <>{children}</>;
  return (
    <Link to={`/items/${itemId}`} className="hover:underline">
      {children}
    </Link>
  );
}
