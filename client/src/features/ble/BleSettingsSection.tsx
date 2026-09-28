import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUTTON, Pill, Section } from "../../components/ui";
import { bleApi } from "./api";
import type { BleStatus } from "./types";

/** The Settings entry point for Bluetooth setup, for administrators. */
export function BleSettingsSection() {
  const [status, setStatus] = useState<BleStatus | null>(null);

  useEffect(() => {
    bleApi.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  return (
    <Section
      title="Bluetooth beacons"
      description="Gateways in each room, tags on equipment, room beacons for phones. Calibrate rooms so tags land in the right one."
      aside={
        <Pill tone={status?.counts.gateways ? "on" : "off"}>
          {status ? `${status.counts.gateways} gateways, ${status.counts.tags} tags` : "Not loaded"}
        </Pill>
      }
    >
      {status && (
        <ul className="mt-3 space-y-1 text-sm text-slate-400">
          <li>
            A tag moves room when another room leads by {status.presence.hysteresisDb} dB for{" "}
            {status.presence.dwellSeconds} s ({status.presence.smoothing} of {status.presence.windowSeconds} s), and is
            missing after {status.missingMinutes} min unheard.
          </li>
          <li>
            Out-of-hours alerts:{" "}
            {status.workHours.configured
              ? `${status.workHours.text} (${status.workHours.timeZone})`
              : status.workHours.error
                ? `off, ${status.workHours.error}`
                : "off (set BLE_WORK_HOURS)"}
          </li>
          <li>
            MQTT:{" "}
            {status.mqtt.configured
              ? `${status.mqtt.connected ? "connected to" : "not connected to"} ${status.mqtt.url}, ${status.mqtt.topics.join(", ")}`
              : "off (set BLE_MQTT_URL)"}
          </li>
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <Link to="/ble?tab=devices" className={BUTTON}>
          Manage Bluetooth devices
        </Link>
        <Link
          to="/ble?tab=calibrate"
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Calibrate a room
        </Link>
      </div>
    </Section>
  );
}
