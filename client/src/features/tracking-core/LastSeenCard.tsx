import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { trackingApi } from "./api";
import { ago, DIRECTION_LABELS, mapUrl, TECH_LABELS } from "./format";
import type { Position, Sighting } from "./types";

/**
 * Where readers last saw an item (and each of its tagged units), with the
 * sightings behind it. Only rendered while the tracking feature is on.
 */
export function LastSeenCard({ itemId }: { itemId: string }) {
  const terms = useTerms();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(() => {
    trackingApi
      .itemPositions(itemId)
      .then(setPositions)
      .catch(() => setPositions([]));
    trackingApi
      .itemSightings(itemId)
      .then((page) => {
        setSightings(page.sightings);
        setNext(page.next);
      })
      .catch(() => undefined);
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await trackingApi.itemSightings(itemId, next);
      setSightings((s) => [...s, ...page.sightings]);
      setNext(page.next);
    } finally {
      setLoadingMore(false);
    }
  };

  if (positions === null) return null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Last seen</h2>
        {sightings.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="text-xs text-sky-400 hover:underline">
            {open ? "Hide sightings" : "Show sightings"}
          </button>
        )}
      </div>

      {positions.length === 0 && sightings.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No reader has detected this {terms.item.singular.toLowerCase()} yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {positions.map((p) => (
            <li key={`${p.itemId}/${p.unitId ?? ""}`} className="text-sm">
              {p.unitId && (
                <span className="mr-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-slate-400">
                  {p.unitLabel || p.unitAssetCode}
                </span>
              )}
              {p.locationId ? (
                <Link to={`/locations/${p.locationId}`} className="font-medium text-sky-300 hover:underline">
                  {p.locationName}
                </Link>
              ) : (
                <span className="text-slate-300">Outside any known zone</span>
              )}
              <span className="text-slate-400">
                {" "}
                · {TECH_LABELS[p.tech]}
                {p.deviceName ? ` via ${p.deviceName}` : ""} ·{" "}
                <span title={new Date(p.observedAt).toLocaleString()}>{ago(p.observedAt).toLowerCase()}</span>
              </span>
              {p.enteredAt && p.locationId && (
                <span className="block text-xs text-slate-500">
                  There since {new Date(p.enteredAt).toLocaleString()}
                  {p.previousLocationName ? `, came from ${p.previousLocationName}` : ""}
                </span>
              )}
              {p.locationId && p.recordedLocationId !== p.locationId && (
                <span className="block text-xs text-amber-400">
                  On file in {p.recordedLocationName ?? `no ${terms.location.singular.toLowerCase()}`}
                </span>
              )}
              {p.lat !== null && p.lng !== null && (
                <a
                  href={mapUrl(p.lat, p.lng)}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-xs text-sky-400 hover:underline"
                >
                  Map: {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          <ol className="space-y-1 text-sm">
            {sightings.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-2 text-slate-400">
                <span className="text-slate-300">{new Date(s.observedAt).toLocaleString()}</span>
                <span>{s.deviceName ?? "Unknown device"}</span>
                {s.locationName && <span className="text-slate-300">{s.locationName}</span>}
                {s.direction && (
                  <span className={s.direction === "in" ? "text-sky-300" : "text-amber-300"}>
                    {DIRECTION_LABELS[s.direction]}
                  </span>
                )}
                {s.unitLabel || s.unitAssetCode ? (
                  <span className="font-mono text-xs">{s.unitLabel || s.unitAssetCode}</span>
                ) : null}
                {s.rssi !== null && <span className="text-xs">{Math.round(s.rssi)} dBm</span>}
                {s.lat !== null && s.lng !== null && (
                  <a href={mapUrl(s.lat, s.lng)} target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:underline">
                    map
                  </a>
                )}
              </li>
            ))}
          </ol>
          {next && (
            <button
              onClick={() => void more()}
              disabled={loadingMore}
              className="mt-2 rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Older sightings"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
