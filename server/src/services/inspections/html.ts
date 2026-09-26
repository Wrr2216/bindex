import { SEVERITY_COLOR } from "./model";
import { formatWhen } from "./pdf";
import type { InspectionReport, ReportComparisonEntry, ReportFinding, ReportSignature } from "./report";

/**
 * The read-only page a share link opens: the same report as the PDF, as one
 * self-contained HTML page with no script, so it opens on any phone without
 * the app and without signing in. Every value is escaped; photos load from
 * the share link's own file route.
 */

const esc = (s: string | number | null | undefined) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#f8fafc}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
.kicker{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b}
h1{font-size:26px;margin:4px 0 2px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #cbd5e1;padding-bottom:6px;margin:32px 0 12px}
h3{font-size:16px;margin:20px 0 8px}
.site{font-size:17px;color:#334155;margin:0}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin:16px 0}
.btn{display:inline-block;background:#0284c7;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:#64748b}dd{margin:0}
.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.count{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px}.count b{display:block;font-size:24px}
.count.alert{border-color:#dc2626;background:#fef2f2;color:#991b1b}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:0 0 10px}
.card.new{border-left:4px solid #dc2626}.card.worsened{border-left:4px solid #ea580c}.card.resolved{border-left:4px solid #059669}
.room{background:#eef2f7;border-radius:8px;padding:6px 10px;font-weight:700;margin:18px 0 8px}
.tag{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;border-radius:999px;padding:1px 8px;margin-left:6px}
.muted{color:#64748b}.small{font-size:13px}.flag{font-size:12px;color:#64748b;margin-left:6px}
.photos{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.photos img{width:200px;max-width:100%;height:150px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;background:#e2e8f0}
.label{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;margin-top:8px}
.sigs{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sig img{max-width:100%;height:70px;object-fit:contain;background:#fff}
.ok{color:#047857;font-weight:600}.bad{color:#b91c1c;font-weight:600}.hash{overflow-wrap:anywhere}
@media (max-width:600px){.counts{grid-template-columns:repeat(2,1fr)}.sigs{grid-template-columns:1fr}}
@media print{.bar a{display:none}body{background:#fff}}
`;

function tag(f: ReportFinding): string {
  const c = SEVERITY_COLOR[f.severity];
  return `<span class="tag" style="color:${c};background:${c}1f">${esc(f.severityLabel)}</span>`;
}

function photos(base: string, list: { id: string }[], label?: string): string {
  if (!list.length) return "";
  return `${label ? `<div class="label">${esc(label)}</div>` : ""}<div class="photos">${list
    .map(
      (p) =>
        `<a href="${base}/files/${esc(p.id)}"><img src="${base}/files/${esc(p.id)}?w=480" alt="" loading="lazy"></a>`,
    )
    .join("")}</div>`;
}

function finding(base: string, f: ReportFinding): string {
  const flags = [f.preExisting ? "Pre-existing" : null, f.aiGenerated ? "Drafted by AI, checked by a person" : null]
    .filter(Boolean)
    .map((x) => `<span class="flag">${esc(x)}</span>`)
    .join("");
  return `<div class="card"><div><b>#${f.number} ${esc(f.spotLabel)}${f.spotDetail ? `, ${esc(f.spotDetail)}` : ""}</b>${tag(f)}${flags}</div>
<div>${esc(f.description)}</div>${photos(base, f.photos)}</div>`;
}

function entry(base: string, e: ReportComparisonEntry): string {
  const f = (e.post ?? e.pre)!;
  const where = `${esc(f.areaLabel)} · ${esc(f.room)} · ${esc(f.spotLabel)}${f.spotDetail ? `, ${esc(f.spotDetail)}` : ""}`;
  const after = e.post
    ? `<div><b>After</b> (#${e.post.number}${tag(e.post)}): ${esc(e.post.description)}</div>`
    : "";
  const before = e.pre
    ? `<div class="muted"><b>Before</b> (pre #${e.pre.number}, ${esc(e.pre.severityLabel.toLowerCase())}): ${esc(e.pre.description)}</div>`
    : "";
  const pics =
    e.change === "new" || e.change === "worsened"
      ? photos(base, e.post?.photos ?? [], "After") + photos(base, e.pre?.photos.slice(0, 3) ?? [], "Before")
      : "";
  const note = e.notedPreExisting ? `<div class="small muted">Marked pre-existing, though not in the pre-inspection.</div>` : "";
  return `<div class="card ${e.change}"><div><b>${where}</b></div>${after}${before}${note}${pics}</div>`;
}

function signature(base: string, label: string, s: ReportSignature | null, tz: string): string {
  if (!s) return `<div class="card sig"><div class="label">${esc(label)}</div><p class="muted">Not signed</p></div>`;
  return `<div class="card sig"><div class="label">${esc(label)}</div>
${s.imageId ? `<img src="${base}/files/${esc(s.imageId)}" alt="Signature of ${esc(s.signerName)}">` : ""}
<div><b>${esc(s.signerName)}</b></div>
<div class="small muted">${esc([s.signerRole, s.signerEmail].filter(Boolean).join(" · "))}</div>
<div class="small muted">Signed ${esc(formatWhen(s.signedAt, tz))}</div>
<div class="small ${s.valid ? "ok" : "bad"}">${s.valid ? "Verified: matches this report as signed" : "Changed since signing"}</div></div>`;
}

export function renderShareHtml(
  report: InspectionReport,
  opts: { base: string; tz?: string; appName: string; expiresAt: Date },
): string {
  const tz = opts.tz ?? "UTC";
  const base = esc(opts.base);
  const n = report.findings.length;
  const details: [string, string][] = [
    ["Site", report.siteName],
    ...(report.siteAddress ? ([["Address", report.siteAddress]] as [string, string][]) : []),
    ...(report.job ? ([["Job", `${report.job.code}, ${report.job.name}`]] as [string, string][]) : []),
    ["Status", report.statusLabel],
    ["Started", formatWhen(report.startedAt, tz)],
    ["Completed", formatWhen(report.completedAt, tz)],
    ["Inspectors", report.inspectors.join(", ") || "Not recorded"],
    ...(report.pre ? ([["Compared with", `${report.pre.code}, pre-move inspection`]] as [string, string][]) : []),
  ];

  let comparison = "";
  if (report.comparison && report.pre) {
    const c = report.comparison.counts;
    const section = (title: string, list: ReportComparisonEntry[]) =>
      list.length ? `<h3>${esc(title)} (${list.length})</h3>${list.map((e) => entry(base, e)).join("")}` : "";
    const by = (k: string) => report.comparison!.entries.filter((e) => e.change === k);
    comparison = `<h2>Comparison with the pre-move inspection ${esc(report.pre.code)}</h2>
<div class="counts">
<div class="count${c.new ? " alert" : ""}"><b>${c.new}</b>New damage</div>
<div class="count"><b>${c.worsened}</b>Worsened</div>
<div class="count"><b>${c.resolved}</b>Gone or not found</div>
<div class="count"><b>${c.unchanged}</b>Unchanged</div>
</div>
${section("New damage", by("new"))}${section("Worse than before", by("worsened"))}${section("Recorded before, not found after", by("resolved"))}${section("Unchanged", by("unchanged"))}`;
  }

  const rooms = report.rooms
    .map(
      (r) =>
        `<div class="room">${r.area === "inside" ? "Inside" : "Outside"} · ${esc(r.room)} <span class="muted small">${r.findings.length}</span></div>${r.findings
          .map((f) => finding(base, f))
          .join("")}`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>${esc(report.kindLabel)} ${esc(report.code)}: ${esc(report.siteName)}</title><style>${STYLE}</style></head>
<body><main>
<div class="kicker">${esc(opts.appName)} · Site inspection report</div>
<h1>${esc(report.kindLabel)}</h1><p class="site">${esc(report.siteName)} · ${esc(report.code)}</p>
<div class="bar"><span class="small muted">Read-only link, valid until ${esc(formatWhen(opts.expiresAt, tz))}.</span>
<a class="btn" href="${base}/report.pdf${opts.tz ? `?tz=${esc(encodeURIComponent(opts.tz))}` : ""}">Download the PDF</a></div>
<dl>${details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
<p><b>${n ? `${n} finding${n === 1 ? "" : "s"} in ${report.rooms.length} room${report.rooms.length === 1 ? "" : "s"} or areas.` : "No damage was recorded."}</b></p>
${report.notes ? `<p class="small">Notes: ${esc(report.notes)}</p>` : ""}
${comparison}
<h2>Findings by room</h2>${rooms || `<p class="muted">No damage was recorded at this site.</p>`}
<h2>Sign-off</h2><div class="sigs">${report.signoffs.map((s) => signature(base, s.label, s.signature, tz)).join("")}</div>
${report.otherSignatures.map((s) => signature(base, s.signerRole ?? "Other signature", s, tz)).join("")}
<p class="small muted hash">Content fingerprint: ${esc(report.contentHash)}</p>
</main></body></html>`;
}

/** A small page for a link that no longer works. */
export function renderShareProblem(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main><div class="kicker">Site inspection report</div><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}
