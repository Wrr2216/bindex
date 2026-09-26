import { useState } from "react";
import { inspectionsApi } from "./api";
import type { ChangeKind, ComparisonEntry, Finding, InspectionDetail, InspectionsMeta } from "./types";
import { BTN_QUIET, CARD, CHANGE_LABEL, H2, Notice, SELECT, SeverityBadge, errorText, spotLabel } from "./ui";

/**
 * The post-inspection against its pre-inspection. New damage first and in red;
 * each post finding can be paired by hand ("same as pre #3", or "new"), and
 * what the room-and-spot rule could not pair can be offered to the AI.
 */

const TONE: Record<ChangeKind, string> = {
  new: "border-red-800 bg-red-950/30",
  worsened: "border-orange-800 bg-orange-950/20",
  resolved: "border-emerald-900 bg-emerald-950/20",
  unchanged: "border-slate-800 bg-slate-900",
};

const COUNT_TONE: Record<ChangeKind, string> = {
  new: "text-red-300",
  worsened: "text-orange-300",
  resolved: "text-emerald-300",
  unchanged: "text-slate-300",
};

const SOURCE_LABEL = { manual: "paired by hand", ai: "paired by AI", room_spot: "same room and spot" } as const;

export function ComparisonPanel({
  inspection,
  meta,
  onChanged,
}: {
  inspection: InspectionDetail;
  meta: InspectionsMeta;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const cmp = inspection.comparison;

  if (!inspection.preInspection || !cmp) {
    return (
      <section className={`${CARD} space-y-2`}>
        <h2 className={H2}>Comparison</h2>
        <Notice tone="warn">
          This post-inspection is not compared with a pre-inspection yet. Pick one under Edit details
          {inspection.editable ? "" : " (reopen it first)"}.
        </Notice>
      </section>
    );
  }

  const byId = new Map([...inspection.findings, ...inspection.preFindings].map((f) => [f.id, f]));
  const unmatchedPost = cmp.entries.filter((e) => e.postId && !e.preId).length;
  const unmatchedPre = cmp.entries.filter((e) => e.change === "resolved").length;

  const matchWithAi = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await inspectionsApi.matchWithAi(inspection.id);
      setMessage(
        !r.available
          ? { tone: "error", text: "The AI could not be reached. Pair them by hand below." }
          : r.paired
            ? { tone: "ok", text: `The AI paired ${r.paired} finding${r.paired === 1 ? "" : "s"}. Check them below.` }
            : { tone: "info", text: "The AI found nothing else that matches." },
      );
      onChanged();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>
          Compared with {inspection.preInspection.code}
          <span className="ml-2 normal-case text-slate-500">pre-move, {inspection.preInspection.status}</span>
        </h2>
        {inspection.editable && meta.ai.languageModel && unmatchedPost > 0 && unmatchedPre > 0 && (
          <button onClick={matchWithAi} disabled={busy} className={BTN_QUIET}>
            {busy ? "Matching…" : "Match the rest with AI"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["new", "worsened", "resolved", "unchanged"] as const).map((k) => (
          <div key={k} className={`rounded-xl border p-3 ${k === "new" && cmp.counts.new ? TONE.new : "border-slate-800 bg-slate-900"}`}>
            <div className={`text-2xl font-semibold ${COUNT_TONE[k]}`}>{cmp.counts[k]}</div>
            <div className="text-xs text-slate-400">{CHANGE_LABEL[k]}</div>
          </div>
        ))}
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {(["new", "worsened", "resolved", "unchanged"] as const).map((k) => {
        const entries = cmp.entries.filter((e) => e.change === k);
        if (!entries.length) return null;
        return (
          <div key={k} className="space-y-2">
            <h3 className={`text-sm font-semibold ${COUNT_TONE[k]}`}>
              {CHANGE_LABEL[k]} ({entries.length})
            </h3>
            {entries.map((e) => (
              <EntryCard
                key={`${e.preId}:${e.postId}`}
                entry={e}
                pre={e.preId ? byId.get(e.preId) ?? null : null}
                post={e.postId ? byId.get(e.postId) ?? null : null}
                inspection={inspection}
                meta={meta}
                onChanged={onChanged}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function Side({ label, finding }: { label: string; finding: Finding | null }) {
  if (!finding) {
    return (
      <div className="flex-1 rounded-lg border border-dashed border-slate-800 p-2 text-sm text-slate-500">
        {label}: not recorded
      </div>
    );
  }
  return (
    <div className="flex-1 space-y-1 rounded-lg bg-slate-950/40 p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="font-semibold uppercase">{label}</span>
        <span>#{finding.number}</span>
        <SeverityBadge severity={finding.severity} />
      </div>
      <p className="text-sm text-slate-200">{finding.description}</p>
      {finding.photos.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {finding.photos.slice(0, 3).map((p) => (
            <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
              <img src={p.thumbUrl ?? p.url} alt="" className="h-20 w-20 rounded object-cover" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  pre,
  post,
  inspection,
  meta,
  onChanged,
}: {
  entry: ComparisonEntry;
  pre: Finding | null;
  post: Finding | null;
  inspection: InspectionDetail;
  meta: InspectionsMeta;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const f = (post ?? pre)!;
  const choice = !post ? null : post.pairSource === "manual" ? post.pairedWithId ?? "new" : "auto";

  const pair = async (value: string) => {
    if (!post) return;
    setError(null);
    try {
      await inspectionsApi.pair(
        inspection.id,
        post.id,
        value === "auto" ? { auto: true } : { preFindingId: value === "new" ? null : value },
      );
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className={`space-y-2 rounded-xl border p-3 ${TONE[entry.change]}`}>
      <div className="flex flex-wrap items-center gap-x-2 text-sm">
        <span className="font-medium text-slate-100">
          {f.area === "outside" ? "Outside" : "Inside"} · {f.room} · {spotLabel(meta, f.spot)}
          {f.spotDetail ? `, ${f.spotDetail}` : ""}
        </span>
        {entry.source && <span className="text-xs text-slate-500">{SOURCE_LABEL[entry.source]}</span>}
        {entry.notedPreExisting && <span className="text-xs text-amber-300">marked as already there</span>}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Side label="Before" finding={pre} />
        <Side label="After" finding={post} />
      </div>
      {post && inspection.editable && (
        <select
          value={choice ?? "auto"}
          onChange={(e) => void pair(e.target.value)}
          aria-label={`Pair finding #${post.number}`}
          className={`${SELECT} w-full text-xs`}
        >
          <option value="auto">Pair automatically</option>
          <option value="new">Not in the pre-inspection</option>
          {inspection.preFindings.map((p) => (
            <option key={p.id} value={p.id}>
              Same as pre #{p.number}: {p.room} · {spotLabel(meta, p.spot)}: {p.description.slice(0, 60)}
            </option>
          ))}
        </select>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
