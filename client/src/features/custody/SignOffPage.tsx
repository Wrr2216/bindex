import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { custodyApi, type OutcomeInput } from "./api";
import { Signatures } from "./TransferPage";
import type { Outcome, PartyInput, ReviewLine, ShipmentReview, TransferDetail } from "./types";
import { BTN, CARD, FIELD, H2, OUTCOME_TEXT, OutcomeBadge, PartyFields, SELECT, StatusBadge, errorText, when } from "./ui";

const stageText = (s: string) => s.replace(/_/g, " ");
const flagged = (stage: string) => ["missing", "damaged", "refused", "wrong_shipment"].includes(stage);

function ReviewRow({
  line,
  outcome,
  note,
  editable,
  onChange,
}: {
  line: ReviewLine;
  outcome: Outcome;
  note: string;
  editable: boolean;
  onChange: (outcome: Outcome, note: string) => void;
}) {
  const photos = line.photos.length ? line.photos.map((p) => ({ key: p.id, src: p.thumbUrl, label: p.caption ?? p.stage ?? "" })) : [];
  if (!photos.length && line.picture) photos.push({ key: "main", src: line.picture, label: "" });
  return (
    <li className={`flex flex-wrap gap-3 py-3 ${outcome === "accepted" ? "" : "bg-red-950/20"}`}>
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/items/${line.itemId}`} className="font-medium text-slate-100 hover:underline">
            {line.name}
          </Link>
          {line.controlled && <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-300">Custody-controlled</span>}
          {flagged(line.stage) && <span className="rounded-full bg-red-950 px-2 py-0.5 text-xs text-red-300">Flagged {stageText(line.stage)}</span>}
        </div>
        <p className="font-mono text-xs text-slate-400">
          {line.unitCode ?? line.assetCode}
          {line.crateNo ? ` · crate ${line.crateNo}` : ""}
          {line.destination ? ` · to ${line.destination}` : ""}
          {` · ${stageText(line.stage)}`}
        </p>
        {line.sub && <p className="text-xs text-slate-500">{line.sub}</p>}
        {photos.length > 0 && (
          <div className="mt-2 flex gap-2">
            {photos.map((p) => (
              <a key={p.key} href={p.src.replace(/\/thumb\?w=\d+$/, "")} target="_blank" rel="noreferrer" title={p.label}>
                <img src={p.src} alt={p.label || `Photo of ${line.name}`} className="h-16 w-16 rounded-md border border-slate-700 object-cover" />
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="flex w-full flex-col gap-1 sm:w-52">
        {editable ? (
          <>
            <select
              value={outcome}
              onChange={(e) => onChange(e.target.value as Outcome, note)}
              aria-label={`What was found for ${line.name}`}
              className={`${SELECT} ${outcome === "accepted" ? "" : "border-red-800 text-red-200"}`}
            >
              {(Object.keys(OUTCOME_TEXT) as Outcome[]).map((k) => (
                <option key={k} value={k}>
                  {OUTCOME_TEXT[k]}
                </option>
              ))}
            </select>
            {outcome !== "accepted" && (
              <input
                value={note}
                onChange={(e) => onChange(outcome, e.target.value)}
                placeholder="What was wrong"
                maxLength={500}
                aria-label={`Note for ${line.name}`}
                className={FIELD}
              />
            )}
          </>
        ) : (
          <div className="space-y-1">
            <OutcomeBadge outcome={outcome} />
            {note && <p className="text-xs text-red-300">{note}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Delivery sign-off for one shipment: every line with its photos and flags,
 * the receiver's findings, and their signature, on this device or their own.
 */
export function SignOffPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const terms = useTerms();
  const [review, setReview] = useState<ShipmentReview | null>(null);
  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [marks, setMarks] = useState<Record<string, { outcome: Outcome; note: string }>>({});
  const [receiver, setReceiver] = useState<PartyInput>({ kind: "external", name: "", org: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    custodyApi
      .review(id)
      .then((r) => {
        setReview(r);
        setTransfer(r.open);
      })
      .catch((err) => setError(errorText(err, "The shipment could not be loaded.")));
  }, [id]);
  useEffect(load, [load]);

  // Transfer lines keyed by the manifest line they came from.
  const lineOf = useMemo(() => new Map((transfer?.lines ?? []).map((l) => [l.jobItemId, l])), [transfer]);
  const outcomes = useMemo<OutcomeInput[]>(
    () =>
      Object.entries(marks).flatMap(([jobItemId, m]) => {
        const l = lineOf.get(jobItemId);
        return l ? [{ lineId: l.id, outcome: m.outcome, note: m.note.trim() || null }] : [];
      }),
    [marks, lineOf],
  );

  if (!review) return error ? <p className="text-red-300">{error}</p> : <p className="text-slate-400">Loading…</p>;
  const s = review.shipment;
  const editable = transfer?.status === "draft";

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setTransfer(await custodyApi.startSignOff(s.id, { to: receiver }));
    } catch (err) {
      setError(errorText(err, "The sign-off could not be started."));
    } finally {
      setBusy(false);
    }
  };

  const valueFor = (line: ReviewLine) => {
    const mark = marks[line.jobItemId];
    if (mark) return mark;
    const l = lineOf.get(line.jobItemId);
    return { outcome: l?.outcome ?? line.presetOutcome, note: l?.note ?? "" };
  };
  const exceptions = review.lines.filter((l) => valueFor(l).outcome !== "accepted").length;

  return (
    <div className="space-y-4">
      <Link to="/custody" className="text-sm text-sky-300 hover:underline">
        ← Chain of custody
      </Link>
      <section className={`${CARD} space-y-1`}>
        <p className="text-xs uppercase tracking-wide text-slate-400">Delivery sign-off</p>
        <h1 className="text-2xl font-semibold text-slate-100">
          <span className="font-mono text-sky-300">{s.code}</span> {s.name}
        </h1>
        <p className="text-sm text-slate-400">
          {s.jobCode} {s.jobName} · {stageText(s.status)}
          {s.carrier ? ` · ${s.carrier}` : ""}
          {s.sealNumbers.length ? ` · seals ${s.sealNumbers.join(", ")}` : ""}
        </p>
        {transfer && (
          <p className="flex items-center gap-2 pt-1 text-sm text-slate-300">
            <Link to={`/custody/transfers/${transfer.id}`} className="font-mono text-sky-300 hover:underline">
              {transfer.code}
            </Link>
            <StatusBadge status={transfer.status} />
            <span>
              {transfer.fromName} → {transfer.toName}
            </span>
          </p>
        )}
      </section>

      {error && <p className="rounded-lg bg-red-950/60 px-3 py-2 text-sm text-red-300">{error}</p>}

      {!transfer && (
        <section className={`${CARD} space-y-3`}>
          <h2 className={H2}>Who is receiving?</h2>
          <PartyFields label="Received by" value={receiver} onChange={setReceiver} allowMe />
          <button onClick={() => void start()} disabled={busy} className={BTN}>
            {busy ? "Starting…" : "Start the review"}
          </button>
        </section>
      )}

      <section className={`${CARD} space-y-2`} aria-label="Lines">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={H2}>
            {review.lines.length} line{review.lines.length === 1 ? "" : "s"} on this shipment
          </h2>
          {exceptions > 0 && <span className="text-sm text-red-300">{exceptions} marked</span>}
        </div>
        {editable && (
          <p className="text-sm text-slate-400">
            Check each {terms.item.singular.toLowerCase()} against what arrived. Mark anything missing, damaged or refused; everything else is
            recorded as received.
          </p>
        )}
        <ul className="divide-y divide-slate-800">
          {review.lines.map((line) => {
            const v = valueFor(line);
            return (
              <ReviewRow
                key={line.jobItemId}
                line={line}
                outcome={v.outcome}
                note={v.note}
                editable={editable}
                onChange={(outcome, note) => setMarks((m) => ({ ...m, [line.jobItemId]: { outcome, note } }))}
              />
            );
          })}
        </ul>
      </section>

      {transfer && transfer.status !== "void" && (
        <Signatures
          transfer={transfer}
          outcomes={outcomes}
          beforeLink={
            editable
              ? async () => {
                  if (outcomes.length) await custodyApi.setOutcomes(transfer.id, outcomes);
                }
              : undefined
          }
          onChanged={(next) => {
            setTransfer(next);
            if (next.status === "completed") navigate(`/custody/transfers/${next.id}`);
          }}
        />
      )}

      {review.deliveries.some((d) => d.status === "completed") && (
        <section className={`${CARD} space-y-2`}>
          <h2 className={H2}>Signed deliveries</h2>
          <ul className="space-y-1 text-sm">
            {review.deliveries
              .filter((d) => d.status === "completed")
              .map((d) => (
                <li key={d.id}>
                  <Link to={`/custody/transfers/${d.id}`} className="font-mono text-sky-300 hover:underline">
                    {d.code}
                  </Link>{" "}
                  {d.toName} · {when(d.at)}
                  {d.exceptionCount ? ` · ${d.exceptionCount} exception${d.exceptionCount === 1 ? "" : "s"}` : ""}
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
