import { useEffect, useState } from "react";
import { useFeatures } from "../../config/useConfig";
import { trackingApi } from "./api";
import { channelOf, RFID_KINDS } from "./format";
import type { TrackingDevice } from "./types";

const INPUT =
  "w-32 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-60";

/**
 * The reader channel for the Building Audit. With tracking on, registered
 * readers are listed by name; "Other" keeps free text for a bridge that is not
 * registered yet. With tracking off it is the plain text box it always was.
 */
export function ReaderChannelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (channel: string) => void;
  disabled?: boolean;
}) {
  const features = useFeatures();
  const [devices, setDevices] = useState<TrackingDevice[] | null>(null);
  const [other, setOther] = useState(false);

  useEffect(() => {
    if (!features.tracking) return;
    trackingApi
      .listDevices(RFID_KINDS)
      .then((list) => setDevices(list.filter((d) => !d.disabled)))
      .catch(() => setDevices([]));
  }, [features.tracking]);

  const text = (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.trim())}
      disabled={disabled}
      aria-label="Reader channel id"
      placeholder="reader id"
      className={INPUT}
    />
  );

  if (!features.tracking || !devices || devices.length === 0) return text;

  const known = devices.some((d) => channelOf(d) === value);
  const showText = other || !known;

  return (
    <>
      <select
        value={showText ? "__other" : value}
        onChange={(e) => {
          if (e.target.value === "__other") {
            setOther(true);
          } else {
            setOther(false);
            onChange(e.target.value);
          }
        }}
        disabled={disabled}
        aria-label="Reader"
        className="max-w-full rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-60 sm:max-w-64"
      >
        {devices.map((d) => (
          <option key={d.id} value={channelOf(d)}>
            {d.name}
            {d.locationName ? ` (${d.locationName})` : ""}
          </option>
        ))}
        <option value="__other">Other channel…</option>
      </select>
      {showText && text}
    </>
  );
}
