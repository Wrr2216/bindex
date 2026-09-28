import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUTTON, Pill, Section } from "../../components/ui";
import { trackingApi } from "./api";

/** The Settings entry point for the device registry, for administrators. */
export function DevicesSettingsSection() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    trackingApi
      .listDevices()
      .then((d) => setCount(d.length))
      .catch(() => setCount(null));
  }, []);

  return (
    <Section
      title="Readers and devices"
      description="Fixed RFID readers, dock portals, gateways, tags and trackers. Each reporting device gets its own ingest token, a zone, and a choice of whether its reads move things."
      aside={<Pill tone={count ? "on" : "off"}>{count === null ? "Not loaded" : `${count} registered`}</Pill>}
    >
      <div className="mt-4 flex flex-wrap gap-3">
        <Link to="/settings/devices" className={BUTTON}>
          Manage readers and devices
        </Link>
        <Link
          to="/tracking"
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          Live reads
        </Link>
      </div>
    </Section>
  );
}
