import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUTTON, BUTTON_QUIET, Pill, Section } from "../../components/ui";
import { gpsApi } from "./api";
import type { MapConfig } from "./types";

/** The Settings entry point for GPS: geofences, trackers, and where trackers post. */
export function GpsSettingsSection() {
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [counts, setCounts] = useState<{ trackers: number; fences: number } | null>(null);

  useEffect(() => {
    gpsApi.config().then(setConfig).catch(() => undefined);
    Promise.all([gpsApi.trackers(), gpsApi.geofences(true)])
      .then(([t, f]) => setCounts({ trackers: t.length, fences: f.length }))
      .catch(() => setCounts(null));
  }, []);

  let tiles = "";
  try {
    tiles = config ? new URL(config.tileUrl.replace(/\{[^}]*\}/g, "a")).host : "";
  } catch {
    tiles = config?.tileUrl ?? "";
  }

  return (
    <Section
      title="GPS tracking"
      description="Trackers report positions over the OsmAnd protocol, through a Traccar server, or in batches. Geofences decide when shipments leave and arrive."
      aside={
        <Pill tone={counts?.trackers ? "on" : "off"}>{counts ? `${counts.trackers} trackers` : "Not loaded"}</Pill>
      }
    >
      {config && (
        <dl className="mt-3 space-y-1 text-sm text-slate-400">
          <div>
            <dt className="inline text-slate-300">Phones (Traccar Client, OsmAnd): </dt>
            <dd className="inline break-all font-mono text-xs">{config.endpoints.osmand}?token=…</dd>
          </div>
          <div>
            <dt className="inline text-slate-300">Traccar server forwarding: </dt>
            <dd className="inline break-all font-mono text-xs">{config.endpoints.traccar}</dd>
          </div>
          {counts && (
            <div>
              <dt className="inline text-slate-300">Geofences: </dt>
              <dd className="inline">{counts.fences}</dd>
            </div>
          )}
          <div>
            <dt className="inline text-slate-300">Map tiles from: </dt>
            <dd className="inline">{tiles} (set MAP_TILE_URL to change)</dd>
          </div>
        </dl>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <Link to="/gps/geofences" className={BUTTON}>
          Geofences
        </Link>
        <Link to="/gps/trackers" className={BUTTON_QUIET}>
          Trackers
        </Link>
        <Link to="/gps" className={BUTTON_QUIET}>
          Live map
        </Link>
      </div>
    </Section>
  );
}
