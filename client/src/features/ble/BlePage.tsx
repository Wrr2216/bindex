import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { bleApi } from "./api";
import { BleDevicesView } from "./BleDevicesView";
import { CalibrateView } from "./CalibrateView";
import { AlertsView, BatteryView, NotSeenView } from "./ListsViews";
import { OccupancyView } from "./OccupancyView";
import type { BleStatus } from "./types";
import { CurrentRoomChip } from "./useBleRoom";

type Tab = "rooms" | "quiet" | "battery" | "alerts" | "devices" | "calibrate";

/** The Bluetooth page: where things are, what has gone quiet, and (for administrators) setup. */
export function BlePage() {
  const { user } = useAuth();
  const terms = useTerms();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<BleStatus | null>(null);
  const isAdmin = user?.role === "admin";

  const tabs: { id: Tab; label: string }[] = [
    { id: "rooms", label: terms.location.plural },
    { id: "quiet", label: "Not seen" },
    { id: "battery", label: "Batteries" },
    { id: "alerts", label: "Alerts" },
    ...(isAdmin
      ? [
          { id: "devices" as const, label: "Devices" },
          { id: "calibrate" as const, label: "Calibrate" },
        ]
      : []),
  ];
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = tabs.some((t) => t.id === requested) ? requested! : "rooms";

  useEffect(() => {
    bleApi.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Bluetooth</h1>
          <p className="text-sm text-slate-400">
            Tags on equipment, heard by gateways in each {terms.location.singular.toLowerCase()}, placed in the one
            that hears them best.
          </p>
        </div>
        <CurrentRoomChip />
      </div>

      {status && (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>
            {status.counts.gateways} gateways · {status.counts.tags} tags · {status.counts.beacons} room beacons
          </span>
          <span>
            Moves after {status.presence.hysteresisDb} dB for {status.presence.dwellSeconds} s · missing after{" "}
            {status.missingMinutes} min
          </span>
          {status.mqtt.configured && (
            <span className={status.mqtt.connected ? "text-emerald-500" : "text-amber-400"} title={status.mqtt.lastError ?? undefined}>
              MQTT {status.mqtt.connected ? "connected" : "not connected"} ({status.mqtt.messages} messages)
            </span>
          )}
          {status.workHours.error && <span className="text-amber-400">Working hours: {status.workHours.error}</span>}
        </p>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-slate-800" aria-label="Bluetooth views">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setParams(t.id === "rooms" ? {} : { tab: t.id })}
            aria-current={t.id === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              t.id === tab ? "border-sky-500 text-sky-300" : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "rooms" && <OccupancyView />}
      {tab === "quiet" && <NotSeenView />}
      {tab === "battery" && <BatteryView />}
      {tab === "alerts" && <AlertsView />}
      {tab === "devices" && <BleDevicesView />}
      {tab === "calibrate" && <CalibrateView />}
    </div>
  );
}
