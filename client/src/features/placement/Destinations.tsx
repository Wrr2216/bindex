import { useCallback, useEffect, useRef, useState } from "react";
import { useTerms } from "../../config/useConfig";
import { BTN, BTN_QUIET, CARD, H2, LocationSelect, Notice, SELECT, errorText, useLocations } from "../jobs-core/ui";
import { placementApi } from "./api";
import type { JobProgress, ProposalReason, Proposals, RoomMapRow } from "./types";
import { labelCode, pathText, shortPath } from "./ui";

/**
 * Destination rules for one job: a room map (this origin room goes to that
 * destination room), proposals for every line with no destination, and the
 * colour of each floor.
 */

const REASON_TEXT: Record<ProposalReason, string> = {
  room_map: "room map",
  same_path: "same place",
  same_name: "same name",
  department: "department",
};

const UNMATCHED_TEXT = {
  no_origin: "No origin recorded",
  no_match: "Nothing matches",
  ambiguous: "More than one match",
};

type Row = { key: number; originLocationId: string; destinationLocationId: string };

export function Destinations({
  jobId,
  progress,
  onChanged,
}: {
  jobId: string;
  progress: JobProgress;
  onChanged: () => void;
}) {
  const terms = useTerms();
  const { options } = useLocations();
  const [originRootId, setOriginRootId] = useState(progress.job.origin?.id ?? "");
  const [destinationRootId, setDestinationRootId] = useState(progress.job.destination?.id ?? "");
  const [overwrite, setOverwrite] = useState(false);
  const [proposals, setProposals] = useState<Proposals | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  const [savedRows, setSavedRows] = useState<RoomMapRow[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const keySeq = useRef(0);

  const roots = useCallback(
    () => ({ originRootId: originRootId || null, destinationRootId: destinationRootId || null, overwrite }),
    [originRootId, destinationRootId, overwrite],
  );

  const loadProposals = useCallback(() => {
    placementApi
      .proposals(jobId, roots())
      .then((p) => {
        setProposals(p);
        setSkip(new Set());
      })
      .catch((err) => setMessage({ tone: "error", text: errorText(err, "Could not work out proposals.") }));
  }, [jobId, roots]);

  const toRows = useCallback(
    (map: RoomMapRow[]) =>
      map.map((r) => ({ key: ++keySeq.current, originLocationId: r.origin.id, destinationLocationId: r.destination.id })),
    [keySeq],
  );

  useEffect(() => {
    placementApi
      .roomMap(jobId)
      .then((map) => {
        setSavedRows(map);
        setRows(toRows(map));
      })
      .catch(() => undefined);
  }, [jobId, toRows]);
  useEffect(() => loadProposals(), [loadProposals]);
  useEffect(() => {
    setColors(Object.fromEntries(progress.floors.map((f) => [f.floor, f.color])));
  }, [progress.floors]);

  const run = async (what: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: "ok", text: await what() });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "That did not work.") });
    } finally {
      setBusy(false);
    }
  };

  const apply = (all: boolean) =>
    run(async () => {
      const ids = proposals?.proposals.map((p) => p.line.id).filter((id) => all || !skip.has(id));
      const r = await placementApi.applyProposals(jobId, { ...roots(), jobItemIds: all ? undefined : ids });
      onChanged();
      loadProposals();
      return `${r.updated} ${r.updated === 1 ? "line" : "lines"} given a destination.`;
    });

  const saveMap = () =>
    run(async () => {
      const complete = rows.filter((r) => r.originLocationId && r.destinationLocationId);
      const saved = await placementApi.setRoomMap(
        jobId,
        complete.map(({ originLocationId, destinationLocationId }) => ({ originLocationId, destinationLocationId })),
      );
      setSavedRows(saved);
      setRows(toRows(saved));
      loadProposals();
      return "Room map saved. Proposals below use it.";
    });

  const saveColors = () =>
    run(async () => {
      const custom = Object.fromEntries(
        Object.entries(colors).filter(([floor, color]) => progress.floors.find((f) => f.floor === floor)?.color !== color),
      );
      // Keep earlier overrides the person did not touch.
      for (const f of progress.floors) if (f.custom && !(f.floor in custom)) custom[f.floor] = colors[f.floor] ?? f.color;
      await placementApi.setFloorColors(jobId, custom);
      onChanged();
      return "Floor colours saved.";
    });

  const resetColors = () =>
    run(async () => {
      await placementApi.setFloorColors(jobId, {});
      onChanged();
      return "Floor colours back to standard.";
    });

  const mapDirty =
    JSON.stringify(rows.filter((r) => r.originLocationId && r.destinationLocationId).map((r) => [r.originLocationId, r.destinationLocationId])) !==
    JSON.stringify(savedRows.map((r) => [r.origin.id, r.destination.id]));

  return (
    <div className="space-y-4">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <section className={`${CARD} space-y-3`}>
        <div>
          <h2 className={H2}>Proposed destinations</h2>
          <p className="mt-1 text-sm text-slate-400">
            For lines with no destination: the room map first, then the same place under the new site, then a room with the
            same name, then the line's department. Nothing is guessed between two matches.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm text-slate-400">
            Moving from
            <LocationSelect
              value={originRootId}
              onChange={setOriginRootId}
              options={options}
              label="Moving from"
              placeholder="Anywhere"
              className={`${SELECT} mt-1 w-full`}
            />
          </label>
          <label className="text-sm text-slate-400">
            Moving to
            <LocationSelect
              value={destinationRootId}
              onChange={setDestinationRootId}
              options={options}
              label="Moving to"
              placeholder="Anywhere"
              className={`${SELECT} mt-1 w-full`}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          Also replace destinations already set
        </label>

        {proposals && (
          <>
            {proposals.proposals.length === 0 ? (
              <p className="text-sm text-slate-400">
                No proposals.{" "}
                {proposals.skipped > 0 && `${proposals.skipped} ${proposals.skipped === 1 ? "line has" : "lines have"} a destination already.`}
              </p>
            ) : (
              <>
                <ul className="max-h-96 overflow-y-auto">
                  {proposals.proposals.map((p) => (
                    <li key={p.line.id} className="flex flex-wrap items-center gap-x-3 border-b border-slate-800 py-1.5 text-sm last:border-0">
                      <input
                        type="checkbox"
                        aria-label={`Apply to ${p.line.itemName}`}
                        checked={!skip.has(p.line.id)}
                        onChange={(e) =>
                          setSkip((s) => {
                            const next = new Set(s);
                            if (e.target.checked) next.delete(p.line.id);
                            else next.add(p.line.id);
                            return next;
                          })
                        }
                      />
                      <span className="text-slate-100">{p.line.itemName}</span>
                      <span className="font-mono text-xs text-slate-500">{labelCode(p.line)}</span>
                      <span className="text-slate-400">{p.line.origin ? shortPath(p.line.origin) : "?"} →</span>
                      <span className="text-emerald-300">{pathText(p.destination)}</span>
                      {p.replaces && <span className="text-xs text-amber-300">replaces {shortPath(p.replaces)}</span>}
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{REASON_TEXT[p.reason]}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => void apply(false)} disabled={busy} className={BTN}>
                    Apply {proposals.proposals.length - skip.size} ticked
                  </button>
                  {skip.size > 0 && (
                    <button onClick={() => void apply(true)} disabled={busy} className={BTN_QUIET}>
                      Apply all {proposals.proposals.length}
                    </button>
                  )}
                </div>
              </>
            )}

            {proposals.unmatched.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-amber-300">
                  {proposals.unmatched.length} {proposals.unmatched.length === 1 ? "line" : "lines"} with nothing to propose
                </summary>
                <ul className="mt-2 max-h-72 overflow-y-auto">
                  {proposals.unmatched.map((u) => (
                    <li key={u.line.id} className="border-b border-slate-800 py-1.5 last:border-0">
                      <span className="text-slate-100">{u.line.itemName}</span>
                      <span className="ml-2 text-slate-400">from {u.line.origin ? pathText(u.line.origin) : "?"}</span>
                      <span className="ml-2 text-amber-300">{UNMATCHED_TEXT[u.reason]}</span>
                      {u.candidates.length > 0 && (
                        <span className="ml-2 text-xs text-slate-500">({u.candidates.map(pathText).join("; ")})</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      <section className={`${CARD} space-y-3`}>
        <div>
          <h2 className={H2}>Room map</h2>
          <p className="mt-1 text-sm text-slate-400">
            Where each origin room goes. A row covers everything inside the origin room: with Finance mapped to Finance on
            level 5, a desk inside it goes to the desk of the same name there, or to the room when there is none.
          </p>
        </div>
        {rows.length === 0 && <p className="text-sm text-slate-500">No rows yet.</p>}
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-2">
              <LocationSelect
                value={r.originLocationId}
                onChange={(v) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, originLocationId: v } : x)))}
                options={options}
                label="Origin room"
                placeholder={`Origin ${terms.location.singular.toLowerCase()}`}
                className={`${SELECT} min-w-0 flex-1`}
              />
              <span className="text-slate-500">→</span>
              <LocationSelect
                value={r.destinationLocationId}
                onChange={(v) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, destinationLocationId: v } : x)))}
                options={options}
                label="Destination room"
                placeholder={`Destination ${terms.location.singular.toLowerCase()}`}
                className={`${SELECT} min-w-0 flex-1`}
              />
              <button
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:text-red-300"
                aria-label="Remove row"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setRows((rs) => [...rs, { key: ++keySeq.current, originLocationId: "", destinationLocationId: "" }])}
            className={BTN_QUIET}
          >
            Add a row
          </button>
          <button onClick={() => void saveMap()} disabled={busy || !mapDirty} className={BTN}>
            Save room map
          </button>
        </div>
        {proposals && proposals.unmatchedOrigins.length > 0 && (
          <div className="text-sm">
            <p className="text-slate-400">Origins with nothing to propose:</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {proposals.unmatchedOrigins
                .filter((o) => !rows.some((r) => r.originLocationId === o.origin.id))
                .slice(0, 30)
                .map((o) => (
                  <button
                    key={o.origin.id}
                    onClick={() =>
                      setRows((rs) => [...rs, { key: ++keySeq.current, originLocationId: o.origin.id, destinationLocationId: "" }])
                    }
                    className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800"
                    title="Add a room map row for it"
                  >
                    + {shortPath(o.origin)} ({o.lines})
                  </button>
                ))}
            </div>
          </div>
        )}
      </section>

      {progress.floors.length > 0 && (
        <section className={`${CARD} space-y-3`}>
          <div>
            <h2 className={H2}>Floor colours</h2>
            <p className="mt-1 text-sm text-slate-400">
              The band on every card and on the kiosk. Match them to the signage on site.
            </p>
          </div>
          <ul className="flex flex-wrap gap-3">
            {progress.floors.map((f) => (
              <li key={f.floor} className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="color"
                  value={colors[f.floor] ?? f.color}
                  onChange={(e) => setColors((c) => ({ ...c, [f.floor]: e.target.value }))}
                  aria-label={`Colour for ${f.floor}`}
                  className="h-8 w-10 cursor-pointer rounded border border-slate-700 bg-slate-800"
                />
                {f.floor}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void saveColors()} disabled={busy} className={BTN}>
              Save colours
            </button>
            {progress.floors.some((f) => f.custom) && (
              <button onClick={() => void resetColors()} disabled={busy} className={BTN_QUIET}>
                Back to standard
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
