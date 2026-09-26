import { useEffect, useState } from "react";
import { useFeatures } from "../../config/useConfig";
import { bleApi } from "./api";
import { ago } from "./format";
import type { MyRoom } from "./types";

const REFRESH_MS = 30_000;

/**
 * The room the signed-in person's phone last placed them in, refreshed every
 * half minute; null when there is none, or Bluetooth is off. For screens that
 * want to prefill a location, such as placement (T11):
 *
 *   const room = useBleRoom();
 *   const [locationId, setLocationId] = useState(room?.locationId ?? null);
 */
export function useBleRoom(): MyRoom | null {
  const features = useFeatures();
  const [room, setRoom] = useState<MyRoom | null>(null);

  useEffect(() => {
    if (!features.ble) {
      setRoom(null);
      return;
    }
    let active = true;
    const load = () =>
      bleApi
        .myRoom()
        .then((r) => active && setRoom(r))
        .catch(() => active && setRoom(null));
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [features.ble]);

  return room;
}

/** "You are in Dock A", when a phone says so. Renders nothing otherwise. */
export function CurrentRoomChip() {
  const room = useBleRoom();
  if (!room) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-sky-950 px-3 py-1 text-xs text-sky-300"
      title={`From ${room.phoneName ?? "your phone"}${room.beaconName ? ` hearing ${room.beaconName}` : ""}, ${ago(room.observedAt).toLowerCase()}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
      You are in {room.locationName}
    </span>
  );
}
