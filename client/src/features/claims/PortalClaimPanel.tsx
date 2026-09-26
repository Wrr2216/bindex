import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { portalClaimsClient } from "./api";
import type { ClaimType, PortalView } from "./types";
import { BTN, CARD, FIELD, LABEL, MoneyInput, Notice, SELECT, errorText, fmtDateTime, statusText, useCents } from "./ui";

/**
 * Filing a claim from a portal link, for someone outside the organisation:
 * the customer who received a delivery, a site's facilities manager. It is
 * rendered by the portal's own page, which holds the token (and, for a link
 * that needs an emailed code, the pass: hand it the same getter the page's
 * own calls use); it never uses the session. It shows only the delivery the link was given for, and the claims
 * filed through the same link.
 */
export function PortalClaimPanel({ token, getPass }: { token: string; getPass?: () => string | null }) {
  const api = useMemo(() => portalClaimsClient(token, getPass), [token, getPass]);
  const [view, setView] = useState<PortalView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [type, setType] = useState<ClaimType>("damage");
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState("");
  const [picked, setPicked] = useState<Record<string, { damage: string; cents: number | null }>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const money = useCents(view?.claims[0]?.currency);

  const load = () =>
    api
      .view()
      .then(setView)
      .catch((err) => {
        // No portal, claims switched off, or a link that no longer works: the
        // panel is simply not offered, with the reason when there is one.
        setUnavailable(err instanceof ApiError && err.status === 401 ? err.message : "");
      });

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  if (unavailable !== null) return unavailable ? <Notice tone="warn">{unavailable}</Notice> : null;
  if (!view) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api.file({
        type,
        description: description.trim(),
        contactEmail: contact.trim() || null,
        lines: Object.entries(picked).map(([jobItemId, v]) => ({
          jobItemId,
          damageDescription: v.damage.trim() || null,
          estimatedCents: v.cents,
        })),
      });
      setFiled(r.code);
      setDescription("");
      setPicked({});
      await load();
    } catch (err) {
      setError(errorText(err, "The claim could not be sent."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`${CARD} space-y-4`}>
      <h2 className="text-lg font-semibold text-slate-100">Report a problem with this delivery</h2>
      {view.claims.length > 0 && (
        <ul className="space-y-1 text-sm">
          {view.claims.map((c) => (
            <li key={c.code} className="flex flex-wrap gap-x-2 text-slate-300">
              <span className="font-mono text-slate-400">{c.code}</span>
              <span>{c.title}</span>
              <span className="text-slate-400">{statusText(c.status)}</span>
              {c.estimatedTotalCents !== null && <span>{money(c.estimatedTotalCents)}</span>}
              <span className="text-xs text-slate-500">{fmtDateTime(c.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {filed && <Notice tone="ok">Sent as {filed}. Keep this number; the team will be in touch.</Notice>}
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1">
          <span className={LABEL}>What kind of problem</span>
          <select value={type} onChange={(e) => setType(e.target.value as ClaimType)} className={`${SELECT} w-full`}>
            {view.types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}: {t.description}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className={LABEL}>Which items</legend>
          <ul className="max-h-80 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800">
            {view.lines.map((l) => {
              const on = l.jobItemId in picked;
              return (
                <li key={l.jobItemId} className="space-y-2 px-3 py-2">
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const next = { ...picked };
                        if (e.target.checked) next[l.jobItemId] = { damage: "", cents: null };
                        else delete next[l.jobItemId];
                        setPicked(next);
                      }}
                    />
                    <span className="text-sm text-slate-100">{l.itemName}</span>
                    <span className="font-mono text-xs text-slate-500">{l.code}</span>
                    <span className={`text-xs ${l.flagged ? "text-red-300" : "text-slate-400"}`}>{l.stageLabel}</span>
                  </label>
                  {on && (
                    <div className="grid gap-2 pl-7 sm:grid-cols-3">
                      <input
                        value={picked[l.jobItemId]!.damage}
                        onChange={(e) => setPicked({ ...picked, [l.jobItemId]: { ...picked[l.jobItemId]!, damage: e.target.value } })}
                        placeholder="What is wrong with it"
                        aria-label={`What is wrong with ${l.itemName}`}
                        className={`${FIELD} sm:col-span-2`}
                      />
                      <MoneyInput
                        value={picked[l.jobItemId]!.cents}
                        onCommit={(cents) => setPicked({ ...picked, [l.jobItemId]: { ...picked[l.jobItemId]!, cents } })}
                        label={`Estimated cost for ${l.itemName}`}
                        placeholder="Estimate"
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
        <label className="block space-y-1">
          <span className={LABEL}>What happened</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} required className={FIELD} />
        </label>
        <label className="block space-y-1">
          <span className={LABEL}>How to reach you</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Email or phone" className={FIELD} />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end">
          <button type="submit" disabled={saving || !description.trim()} className={BTN}>
            {saving ? "Sending…" : "Send claim"}
          </button>
        </div>
      </form>
    </section>
  );
}
