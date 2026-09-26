import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Pill, Section, Toggle } from "../../components/ui";
import { placementApi } from "./api";
import type { ReadersStatus } from "./types";
import { pathText } from "./ui";

/**
 * Settings, for administrators: which readers confirm placement. A reader in
 * a room places what it reads there when that room is its destination, and
 * flags what belongs in another room. Switch it off for a reader whose zone
 * is a corridor, or that reads through a wall into the next room.
 */
export function PlacementReadersSection() {
  const [status, setStatus] = useState<ReadersStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    placementApi
      .readers()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load readers."));
  }, []);

  const change = async (id: string, patch: { confirm?: boolean; nested?: boolean }) => {
    setError(null);
    try {
      setStatus(await placementApi.setReader(id, patch));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    }
  };

  const worker = status?.worker;
  return (
    <Section
      title="Placement: room readers"
      description="A reader whose zone is a room places what it reads there when that room is where it is going, and flags what belongs in another room this job delivers to. Reads at a dock or in a corridor never flag anything."
      aside={
        <Pill tone={worker?.on ? "on" : "off"}>
          {!worker ? "Not loaded" : worker.on ? `Checked every ${worker.pollSeconds}s` : "Readers do not place"}
        </Pill>
      }
    >
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {status && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-slate-400">
            Bluetooth room presence:{" "}
            {status.ble ? (
              <span className="text-emerald-400">used</span>
            ) : (
              <span>not installed, so Bluetooth reads are not used for placement</span>
            )}
            .
            {worker?.lastRun && (
              <>
                {" "}
                Last check {new Date(worker.lastRun.at).toLocaleTimeString()}: {worker.lastRun.placed} placed,{" "}
                {worker.lastRun.misplaced} in the wrong room.
              </>
            )}
          </p>
          {status.readers.length === 0 ? (
            <p className="text-sm text-slate-500">
              No reader has a zone yet. Give one a room in{" "}
              <Link to="/settings/devices" className="text-sky-400 hover:underline">
                Readers and devices
              </Link>
              .
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {status.readers.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-200">
                      {r.name}
                      {r.disabled && <span className="ml-2 text-xs text-slate-500">disabled</span>}
                    </p>
                    <p className="text-sm text-slate-500">
                      {r.zone ? pathText(r.zone) : "No zone of its own"}
                      {r.antennaZones > 0 && ` · ${r.antennaZones} antenna ${r.antennaZones === 1 ? "zone" : "zones"}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-300">
                    <label className="flex items-center gap-2">
                      Confirms placement
                      <Toggle label={`${r.name} confirms placement`} checked={r.confirm} onChange={(v) => void change(r.id, { confirm: v })} />
                    </label>
                    <label className="flex items-center gap-2" title="Things going to a desk inside its room count as being in its room">
                      Covers desks inside
                      <Toggle label={`${r.name} covers desks inside`} checked={r.nested} onChange={(v) => void change(r.id, { nested: v })} />
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}
