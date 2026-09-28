import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useFeatures } from "../../config/useConfig";
import { bleApi } from "./api";
import { ago, dbm, shortIdentity, signalWord } from "./format";
import type { ItemTagPresence } from "./types";

const REFRESH_MS = 15_000;

/**
 * An item's Bluetooth presence: the room each of its tags is in, what hears it
 * now, and its battery. Renders nothing for an item with no tag, or while
 * Bluetooth is off.
 */
export function BlePresenceCard({ itemId }: { itemId: string }) {
  const features = useFeatures();
  const [tags, setTags] = useState<ItemTagPresence[] | null>(null);

  useEffect(() => {
    if (!features.ble) return;
    let active = true;
    const load = () =>
      bleApi
        .itemPresence(itemId)
        .then((r) => active && setTags(r.tags))
        .catch(() => active && setTags([]));
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [itemId, features.ble]);

  if (!features.ble || !tags?.length) return null;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Bluetooth</h2>
      <ul className="mt-2 space-y-3">
        {tags.map((t) => (
          <li key={t.tagKey} className="text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {t.locationId ? (
                  <Link to={`/locations/${t.locationId}`} className="font-medium text-sky-300 hover:underline">
                    {t.locationName}
                  </Link>
                ) : (
                  <span className="text-slate-300">{t.lastHeardAt ? "Heard, not yet placed" : "Never heard"}</span>
                )}
                {t.missingSince && (
                  <span className="ml-2 rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-300">
                    Missing since {new Date(t.missingSince).toLocaleString()}
                  </span>
                )}
              </span>
              <span className="text-xs text-slate-500">
                {t.tagName ?? shortIdentity(t.identity)}
                {t.batteryPct !== null && (
                  <span className={t.batteryPct <= 20 ? " text-amber-400" : ""}> · battery {t.batteryPct}%</span>
                )}
                {t.temperatureC !== null && <span> · {t.temperatureC.toFixed(1)} °C</span>}
              </span>
            </div>
            {t.locationId && t.zoneSince && (
              <p className="text-xs text-slate-500">
                There since {new Date(t.zoneSince).toLocaleString()}
                {t.previousLocationName ? `, came from ${t.previousLocationName}` : ""}
                {t.lastHeardAt ? ` · last heard ${ago(t.lastHeardAt).toLowerCase()}` : ""}
              </p>
            )}
            {t.candidateZoneName && (
              <p className="text-xs text-sky-400">Looks like it is moving to {t.candidateZoneName}…</p>
            )}
            {t.heard.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {t.heard.map((h) => (
                  <li
                    key={h.gatewayId}
                    className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300"
                    title={`${h.samples} readings in the window`}
                  >
                    {h.gatewayName ?? "Gateway"}
                    {h.zoneName ? ` (${h.zoneName})` : ""}: {signalWord(h.rssi)}, {dbm(h.rssi)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
