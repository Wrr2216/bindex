import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { bleApi } from "./api";
import { ago, dbm, shortIdentity, signalWord } from "./format";
import type { TagPresence, ZoneOccupancy } from "./types";

const REFRESH_MS = 10_000;

function TagLine({ t, missing }: { t: TagPresence; missing?: boolean }) {
  const terms = useTerms();
  const label = t.itemName ?? t.tagName ?? shortIdentity(t.identity);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5 text-sm">
      <span className="min-w-0">
        {t.itemId ? (
          <Link to={`/items/${t.itemId}`} className="font-medium text-sky-300 hover:underline">
            {label}
          </Link>
        ) : (
          <span className="font-medium text-slate-200">
            {label} <span className="text-xs text-slate-500">(not on any {terms.item.singular.toLowerCase()})</span>
          </span>
        )}
        {t.unitLabel && <span className="ml-2 font-mono text-xs text-slate-500">{t.unitLabel}</span>}
      </span>
      <span className={`text-xs ${missing ? "text-amber-400" : "text-slate-400"}`}>
        {missing ? (
          <>Missing since {new Date(t.missingSince!).toLocaleString()}</>
        ) : (
          <>
            {t.zoneSince && <span title={new Date(t.zoneSince).toLocaleString()}>here since {ago(t.zoneSince).toLowerCase()}</span>}
            {t.gatewayName && (
              <span title={dbm(t.rssi)}>
                {" "}
                · {signalWord(t.rssi)} at {t.gatewayName}
              </span>
            )}
          </>
        )}
      </span>
    </li>
  );
}

/** What is in each room now, by Bluetooth. */
export function OccupancyView() {
  const terms = useTerms();
  const [zones, setZones] = useState<ZoneOccupancy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    bleApi
      .occupancy()
      .then((z) => {
        setZones(z);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load rooms."));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (error && !zones) return <p className="text-sm text-red-400">{error}</p>;
  if (!zones) return <p className="py-6 text-center text-slate-500">Loading…</p>;
  if (!zones.length) {
    return (
      <p className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
        No gateways or tags yet. Register a gateway in each {terms.location.singular.toLowerCase()} and a tag on
        each thing to follow, under Devices.
      </p>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {zones.map((z) => (
        <section key={z.locationId ?? "none"} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-slate-100">
              {z.locationId ? (
                <Link to={`/locations/${z.locationId}`} className="hover:underline">
                  {z.locationName}
                </Link>
              ) : (
                <span className="text-slate-300">Heard, but in no {terms.location.singular.toLowerCase()}</span>
              )}
            </h3>
            <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
              {z.present.length} here
            </span>
          </div>
          {z.gateways.length > 0 && (
            <p className="mt-0.5 text-xs text-slate-500">
              {z.gateways.map((g, i) => (
                <span key={g.id} className={g.disabled ? "line-through" : undefined}>
                  {i > 0 && ", "}
                  {g.name} ({ago(g.lastSeenAt).toLowerCase()})
                </span>
              ))}
            </p>
          )}
          {z.present.length === 0 && z.missing.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Nothing here.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-800">
              {z.present.map((t) => (
                <TagLine key={t.tagKey} t={t} />
              ))}
              {z.missing.map((t) => (
                <TagLine key={t.tagKey} t={t} missing />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
