#!/usr/bin/env python3
"""
Bluetooth LE gateway for Bindex room-level presence.

Runs on a Raspberry Pi (or any Linux box with BlueZ) installed in a room,
listens for BLE advertisements with bleak, and posts them in batches to the
server's /api/device/ble/reads endpoint with the gateway's device token. The
server decides which room each tag is in from what every gateway hears; this
script only reports.

Each batch holds, per advertiser and payload, the latest reading since the
last post: its address, signal strength, time, and the advertising data
rebuilt as bytes (bleak hands over the decoded parts, not the raw packet), so
iBeacon, Eddystone (UID, URL, TLM) and AltBeacon frames all reach the server.

Configure with environment variables (see the "BLE gateway" section of
bridge/README.md). SCAN_TEST=1 prints what it hears and posts nothing.

Requires Python 3.8+ and bleak (pip install bleak).
"""
import asyncio
import json
import os
import sys
import time
import urllib.error
import urllib.request


def env(key, default=None):
    value = os.environ.get(key)
    return value if value not in (None, "") else default


def flag(key, default):
    value = os.environ.get(key)
    if value is None or value == "":
        return default
    return value not in ("0", "false", "False", "no")


SERVER_URL = (env("SERVER_URL") or "").rstrip("/")
DEVICE_TOKEN = env("DEVICE_TOKEN") or ""
# Only needed when DEVICE_TOKEN is the shared INGEST_TOKEN: names this gateway.
GATEWAY_ID = env("GATEWAY_ID")
ENDPOINT = env("ENDPOINT", "/api/device/ble/reads")
FLUSH_MS = int(env("FLUSH_MS", "1000"))
MIN_RSSI = int(env("MIN_RSSI", "-100"))
# Forward only beacon frames (iBeacon, Eddystone, AltBeacon). Set 0 to forward
# everything, for tags known only by their MAC; the server keeps unregistered
# devices in memory for its "heard nearby" list and stores nothing of them.
ONLY_BEACONS = flag("ONLY_BEACONS", True)
ADAPTER = env("ADAPTER", "hci0")
SCAN_TEST = flag("SCAN_TEST", False)
# Readings kept while the server cannot be reached, oldest dropped first.
MAX_BACKLOG = int(env("MAX_BACKLOG", "20000"))

APPLE = 0x004C
EDDYSTONE_UUID = "0000feaa-0000-1000-8000-00805f9b34fb"
BASE_UUID_SUFFIX = "-0000-1000-8000-00805f9b34fb"


def short_uuid(uuid):
    """The 16-bit form of a Bluetooth SIG base UUID, or None."""
    u = uuid.lower()
    if u.endswith(BASE_UUID_SUFFIX) and u.startswith("0000"):
        return int(u[4:8], 16)
    return None


def structure(ad_type, payload):
    """One advertising data structure: [length][type][payload]."""
    if len(payload) > 253:
        return b""
    return bytes([len(payload) + 1, ad_type]) + payload


def build_adv_data(manufacturer_data, service_data, local_name=None):
    """
    Advertising data bytes from bleak's decoded parts, in the order a beacon
    sends them. The server parses these exactly as it parses a hardware
    gateway's raw data.
    """
    out = b"\x02\x01\x06"
    uuids16 = []
    for uuid in service_data or {}:
        s = short_uuid(uuid)
        if s is not None:
            uuids16.append(s)
    if uuids16:
        out += structure(0x03, b"".join(s.to_bytes(2, "little") for s in uuids16))
    for company, data in (manufacturer_data or {}).items():
        out += structure(0xFF, company.to_bytes(2, "little") + bytes(data))
    for uuid, data in (service_data or {}).items():
        s = short_uuid(uuid)
        if s is not None:
            out += structure(0x16, s.to_bytes(2, "little") + bytes(data))
    if local_name:
        out += structure(0x09, local_name.encode("utf-8")[:29])
    return out


def is_beacon(manufacturer_data, service_data):
    """iBeacon, AltBeacon or Eddystone: the frames a tag or room beacon sends."""
    for company, data in (manufacturer_data or {}).items():
        data = bytes(data)
        if company == APPLE and data[:2] == b"\x02\x15":
            return True
        if data[:2] == b"\xbe\xac":
            return True
    return any(uuid.lower() == EDDYSTONE_UUID for uuid in (service_data or {}))


_pending = {}  # (address, data hex) -> latest reading since the last post
_backlog = []  # readings a failed post could not deliver
_seen = set()
_stats = {"heard": 0, "posted": 0, "failed": 0}


def on_advertisement(device, adv):
    rssi = getattr(adv, "rssi", None)
    if rssi is None:
        rssi = getattr(device, "rssi", None)
    if rssi is not None and rssi < MIN_RSSI:
        return
    if ONLY_BEACONS and not is_beacon(adv.manufacturer_data, adv.service_data):
        return
    data = build_adv_data(adv.manufacturer_data, adv.service_data, adv.local_name).hex().upper()
    reading = {"mac": device.address, "rssi": rssi, "ts": int(time.time() * 1000), "data": data}
    _pending[(device.address, data)] = reading
    _stats["heard"] += 1
    if SCAN_TEST and device.address not in _seen:
        _seen.add(device.address)
        print(f"  {device.address}  rssi {rssi}  {adv.local_name or ''}  {data}")


def post(reads):
    body = {"reads": reads}
    if GATEWAY_ID:
        body["gateway"] = GATEWAY_ID
    request = urllib.request.Request(
        SERVER_URL + ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {DEVICE_TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read() or b"{}")


async def flush_forever():
    global _backlog
    loop = asyncio.get_running_loop()
    while True:
        await asyncio.sleep(FLUSH_MS / 1000)
        if SCAN_TEST:
            _pending.clear()
            continue
        reads = _backlog + list(_pending.values())
        _pending.clear()
        _backlog = []
        if not reads:
            continue
        try:
            await loop.run_in_executor(None, post, reads)
            _stats["posted"] += len(reads)
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:300]
            _stats["failed"] += 1
            # A 4xx will not get better by retrying; say why and drop the batch.
            if 400 <= err.code < 500:
                print(f"Server refused the batch ({err.code}): {detail}", file=sys.stderr)
            else:
                print(f"Server error {err.code}; will retry: {detail}", file=sys.stderr)
                _backlog = reads[-MAX_BACKLOG:]
        except Exception as err:  # network down, timeout
            _stats["failed"] += 1
            print(f"Could not reach {SERVER_URL}: {err}; will retry", file=sys.stderr)
            _backlog = reads[-MAX_BACKLOG:]


async def report_forever():
    while True:
        await asyncio.sleep(60)
        print(f"heard {_stats['heard']}  posted {_stats['posted']}  failed posts {_stats['failed']}", flush=True)


async def main():
    from bleak import BleakScanner  # imported here so the helpers above work without it

    if not SCAN_TEST and (not SERVER_URL or not DEVICE_TOKEN):
        sys.exit("Set SERVER_URL and DEVICE_TOKEN (or SCAN_TEST=1 to just print what is heard)")

    kwargs = {"detection_callback": on_advertisement}
    if sys.platform.startswith("linux"):
        kwargs["adapter"] = ADAPTER
    scanner = BleakScanner(**kwargs)
    await scanner.start()
    where = "printing only" if SCAN_TEST else f"posting to {SERVER_URL}{ENDPOINT} every {FLUSH_MS} ms"
    print(f"Scanning on {ADAPTER}, {'beacons only' if ONLY_BEACONS else 'everything'}, {where}", flush=True)
    try:
        await asyncio.gather(flush_forever(), report_forever())
    finally:
        await scanner.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
