import { useState, type FormEvent } from "react";
import { claimsApi } from "./api";
import type { Activity, ClaimDetail } from "./types";
import { BTN, CARD, FIELD, H2, Notice, errorText, fmtDateTime, statusText } from "./ui";

/** What happened to the claim itself, oldest first, with a box to comment. */

function describe(a: Activity, incident: boolean): string {
  switch (a.kind) {
    case "created":
      return incident ? "Reported the incident" : "Opened the claim";
    case "status":
      return `${(a.detail.action as string | undefined) ?? "Moved"}: ${statusText(a.fromStatus ?? "")} → ${statusText(a.toStatus ?? "")}`;
    case "assignment":
      return a.body ?? "Changed the reviewer";
    case "lines": {
      const d = a.detail as { added?: unknown[]; updated?: unknown[]; removed?: unknown[]; fields?: string[]; itemName?: string };
      if (d.added?.length) return `Added ${d.added.length} line${d.added.length === 1 ? "" : "s"}`;
      if (d.removed?.length) return `Removed ${d.itemName ?? "a line"}`;
      return `Changed a line (${(d.fields ?? []).join(", ").replace(/Cents/g, "")})`;
    }
    case "update":
      return `Edited ${((a.detail.changed as string[] | undefined) ?? []).join(", ").replace(/Cents/g, "")}`;
    case "export":
      return `Downloaded the ${String(a.detail.format ?? "").toUpperCase()}`;
    case "sla":
      return "Decision deadline passed";
    case "comment":
      return "";
  }
}

export function ActivityFeed({ claim, onComment }: { claim: ClaimDetail; onComment: () => void }) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await claimsApi.comment(claim.id, body.trim());
      setBody("");
      onComment();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className={H2}>Activity</h2>
      <ol className="space-y-3">
        {claim.activity.map((a) => (
          <li key={a.id} className="text-sm">
            <p className="text-xs text-slate-500">
              {a.authorName ?? "System"}
              {a.authorGrantId ? " (portal)" : ""} · {fmtDateTime(a.createdAt)}
              {a.auditLogId !== null && <span className="font-mono"> · audit #{a.auditLogId}</span>}
            </p>
            {a.kind === "comment" ? (
              <p className="whitespace-pre-wrap rounded-lg bg-slate-800/60 px-3 py-2 text-slate-100">{a.body}</p>
            ) : (
              <>
                <p className="text-slate-300">{describe(a, claim.type === "incident")}</p>
                {a.body && a.kind !== "assignment" && <p className="whitespace-pre-wrap text-slate-400">“{a.body}”</p>}
              </>
            )}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="space-y-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="Add a comment for the people working on this claim"
          aria-label="Comment"
          className={FIELD}
        />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end">
          <button type="submit" disabled={saving || !body.trim()} className={BTN}>
            Comment
          </button>
        </div>
      </form>
    </section>
  );
}
