#!/usr/bin/env python3
"""
ThingMagic M7e reader bridge for live audits.

Reads UHF (RAIN/Gen2) EPC tags continuously off the M7e and POSTs newly-seen
EPCs to the app's device-ingest endpoint. The Building Audit screen polls that
channel and streams the reads in live.

Requires the `mercury` module (python-mercuryapi). Configure via environment
variables (see .env.example). Set READ_TEST=1 to just print tags to the console
for first-boot verification (no server needed).

With SEND_READS=1 it posts to /api/device/reads instead, adding each tag's
antenna, signal strength and read time, which the server stores as sightings
(and uses to tell direction on a portal). Off by default: the /scan path is
unchanged.
"""
import json
import os
import signal
import sys
import threading
import urllib.request

import mercury


def env(key, default=None):
    return os.environ.get(key, default)


SERVER_URL = (env("SERVER_URL") or "").rstrip("/")
DEVICE_TOKEN = env("DEVICE_TOKEN") or ""
READER_ID = env("READER_ID") or "default"
SERIAL_PORT = env("SERIAL_PORT") or "/dev/ttyUSB0"
BAUD = int(env("BAUD") or "115200")
REGION = env("REGION") or "NA"
READ_POWER = int(env("READ_POWER") or "2400")  # centi-dBm; +24 dBm = 2400 (Pico max)
FLUSH_MS = int(env("FLUSH_MS") or "200")
READ_TEST = (env("READ_TEST") or "") not in ("", "0", "false", "False")
SEND_READS = (env("SEND_READS") or "") not in ("", "0", "false", "False")

if not READ_TEST:
    if not SERVER_URL:
        sys.exit("Missing SERVER_URL (or set READ_TEST=1 to just print tags)")
    if not DEVICE_TOKEN:
        sys.exit("Missing DEVICE_TOKEN (or set READ_TEST=1 to just print tags)")

ENDPOINT = f"{SERVER_URL}/api/device/reads" if SEND_READS else f"{SERVER_URL}/api/device/scan"

_lock = threading.Lock()
_pending = set()      # EPCs read but not yet POSTed
_detail = {}          # EPC -> strongest (rssi, antenna, time) since the last POST, for SEND_READS
_seen_total = set()   # everything seen this run (console counter)
_stop = threading.Event()


def on_tag(tag):
    epc = tag.epc.hex().upper() if isinstance(tag.epc, (bytes, bytearray)) else str(tag.epc)
    # Not every MercuryAPI build fills these in, so each is optional.
    rssi = getattr(tag, "rssi", None)
    antenna = getattr(tag, "antenna", None)
    seen = getattr(tag, "timestamp", None)
    with _lock:
        _pending.add(epc)
        if SEND_READS:
            prev = _detail.get(epc)
            # Keep the strongest read per flush: it says best where the tag was.
            if prev is None or (rssi is not None and (prev[0] is None or rssi > prev[0])):
                _detail[epc] = (rssi, antenna, seen)
        is_new = epc not in _seen_total
        _seen_total.add(epc)
        total = len(_seen_total)
    if READ_TEST and is_new:
        print(f"  tag {epc}   (unique this run: {total})")


def read_entry(epc, detail):
    entry = {"code": epc}
    rssi, antenna, seen = detail or (None, None, None)
    if rssi is not None:
        entry["rssi"] = rssi
    if antenna is not None:
        entry["antenna"] = antenna
    if seen:
        entry["ts"] = int(float(seen) * 1000)  # epoch milliseconds
    return entry


def post(epcs, details=None):
    if SEND_READS:
        details = details or {}
        payload = {"device": READER_ID, "reads": [read_entry(e, details.get(e)) for e in epcs]}
    else:
        payload = {"reader": READER_ID, "epcs": list(epcs)}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {DEVICE_TOKEN}")
    # Some CDNs/WAFs (e.g. Cloudflare) reject the default "Python-urllib/x.y"
    # User-Agent with a 403 before the request ever reaches the app. Present a
    # plain, named agent so the ingest POST is allowed through.
    req.add_header("User-Agent", "bindex-reader-bridge/1.0")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status


def flush_loop():
    while not _stop.is_set():
        _stop.wait(FLUSH_MS / 1000.0)
        with _lock:
            if not _pending:
                continue
            batch = set(_pending)
            _pending.clear()
            details = dict(_detail)
            _detail.clear()
        if READ_TEST:
            continue
        try:
            post(batch, details)
        except Exception as exc:  # network blip, server restart, etc.
            print(f"POST failed ({exc}); re-queueing {len(batch)}", file=sys.stderr)
            with _lock:
                _pending.update(batch)  # requeued, so nothing is lost
                for epc, detail in details.items():
                    _detail.setdefault(epc, detail)


def configure_read_plan(reader) -> None:
    """
    Set up the GEN2 read plan.

    The M7e-Pico does not support automatic antenna detection, so
    get_connected_ports() is always empty. That is expected, not an error.
    The Pico/Deka carrier multiplexes the single RF port to 4 antenna jacks
    using the module's hardwired GPIO1/GPIO2 lines; logical antenna 1
    (GPIO1=low, GPIO2=low) routes to physical antenna port 1.

    MercuryAPI 1.37 rejects an explicit single-antenna SimpleReadPlan on this
    1.x Pico firmware ("Parameter to command is invalid"), but the default
    (empty antenna list) plan is accepted and the firmware drives the mux to
    logical antenna 1 by default, which is port 1. So we use the default plan,
    which is the working path on this hardware. We still try an explicit
    antenna 1 first in case a future firmware/API accepts it.
    """
    for plan_antennas in ([1], []):
        try:
            reader.set_read_powers([(a, READ_POWER) for a in (plan_antennas or [1])])
            reader.set_read_plan(plan_antennas, "GEN2")
            label = f"antenna {plan_antennas[0]}" if plan_antennas else "default (antenna 1 via mux)"
            print(f"Read plan: {label}, GEN2, power {READ_POWER} cdBm")
            return
        except Exception as exc:
            if not plan_antennas:
                print(
                    f"Could not set read plan: {exc}\n"
                    f"  Check the antenna is on port 1 and GPIO1/GPIO2 jumpers are removed.",
                    file=sys.stderr,
                )


def main():
    print(f"Connecting to {SERIAL_PORT} (region {REGION}, power {READ_POWER} cdBm)…")
    reader = mercury.Reader(f"tmr://{SERIAL_PORT}", baudrate=BAUD)
    reader.set_region(REGION)
    configure_read_plan(reader)

    if READ_TEST:
        print("READ_TEST mode: printing tags, not posting. Ctrl-C to stop.")
    else:
        print(f"Streaming new EPCs -> {ENDPOINT} (reader={READER_ID}). Ctrl-C to stop.")

    threading.Thread(target=flush_loop, daemon=True).start()

    signal.signal(signal.SIGINT, lambda *_: _stop.set())
    signal.signal(signal.SIGTERM, lambda *_: _stop.set())

    reader.start_reading(on_tag)  # async; callback fires per tag
    _stop.wait()
    try:
        reader.stop_reading()
    except Exception:
        pass
    print(f"\nStopped. {len(_seen_total)} unique tags this run.")


if __name__ == "__main__":
    main()
