# Offline field mode

Warehouses with steel racking, basements, the back of a truck: the places
inventory work happens are often the places a phone has no signal. Offline field
mode lets a phone or tablet keep a copy of the parts of the inventory it works
in, keep scanning and recording changes without a connection, and send those
changes when the signal comes back, each one exactly once.

## Turning it on

Two switches, on purpose.

1. **For the instance.** An administrator turns on **Work offline on this
   device** under Settings, Features. This adds an **Offline** screen and
   opens the server endpoints the devices use. It is off by default.
2. **For each device.** On the device itself, open **Offline** and choose what
   to take with you. A device that never does this keeps nothing and behaves
   exactly as before.

The device switch lives in the browser, so it is per browser and per device, not
per account.

## Making things available offline

On the **Offline** screen, pick a location and choose **Make available
offline**. The device downloads:

- every item in that location and every location below it, the containers
  inside them and everything those containers hold, and any item with a unit
  kept there;
- each of those items' identifiers, units (with their codes and serials) and
  open check-outs;
- every location, holder and group, because pickers need all of the choices.

**Everything** takes the whole instance, up to `OFFLINE_SNAPSHOT_MAX_ITEMS`
items (10,000 by default). Larger instances pick locations instead. Several
locations can be kept at once. **Refresh all** fetches them again and drops
anything that has left them; **Remove** drops one.

Items you open while online on a device that works offline are kept too, so a
record that was on screen when the signal dropped still opens.

Taking something offline also keeps who you are signed in as and the instance
settings, so the app itself opens without a connection.

## Working without a connection

When the network is gone, a clear **OFFLINE** badge appears at the bottom of
every screen with the age of the copy ("copy from 2 h ago") and how many changes
are waiting. Everything answered from the copy is marked; nothing from the copy
is ever shown as if it were current.

What keeps working:

| Task | Offline |
| --- | --- |
| Scanning (reader, camera, networked reader) | Resolves identifiers, printed item codes, unit codes and serials from the copy |
| Item and location pages, pickers, lists | From the copy |
| Move an item, or a unit, to a location or into a container | Queued |
| Check out and check in, for items and units | Queued |
| Spot check on retrieval | Queued |
| Verify a location's contents | Reconciled from the copy; applying is queued |
| Building audit | Reconciled against what the device holds; applying is queued |
| Field notes (on the Offline screen) | Queued |
| Photos (the item page's Photo button) | Kept on the device until sent |

Changes appear on the device straight away, so the screens show what you just
did, and the item's history lists them as "waiting to sync".

### What does not work offline

- Creating, editing or deleting items, locations, holders and groups. Only the
  field changes above can wait; anything else says it needs a connection.
- Looking up an unknown barcode, prices, photos from the web, and search by
  question.
- A code that is not in the copy. The scan says so rather than offering to
  create an item.
- The last-resort match on an item's model number, which the server does when
  nothing else matches.
- History, past check-outs and photos of an item. Only open check-outs are
  kept.
- Printing labels and contents sheets.
- Settings, accounts, backups and integrations.
- A building audit offline covers only what the device holds. An item that was
  never taken offline is neither seen nor missing, and its code shows as
  unknown.
- The app opening without a connection needs HTTPS (or `localhost`), because
  browsers only run the service worker that keeps the app on a secure origin.
  Over plain HTTP the device still copes with losing the signal while the app is
  open.

## Sending changes

Changes are sent oldest first, as soon as there is a connection: when the
browser says the network is back, when the app comes back into focus, every
half minute while anything is waiting, and, where the browser supports
Background Sync, when the browser wakes the app to say it is a good time.
Background Sync needs an open app to do the sending; with the app closed, the
queue goes the next time it opens. **Sync now** on the Offline screen sends
straight away.

Each change carries an **Idempotency-Key** made on the device when the change
was made. If a change reached the server but the answer never came back, sending
it again returns the stored answer instead of applying it twice. A change that
has not been answered within 15 seconds is queued, so a slow network behaves
like no network, safely.

Before sending, the device asks the server to plan the queue: which changes can
go, in what order, and which no longer fit what the server has. Changes to the
same item or unit keep their order: if one needs a decision, the later ones for
that same item wait behind it. Other items carry on. Verification and audit
results are observations of the shelf and never wait on anything else.

### Needs attention

A change that no longer fits the server goes to **Needs attention** on the
Offline screen, with the reason, and stays there until someone decides:

- **Keep mine** sends it anyway, overriding what changed on the server.
- **Keep the server's** discards it and fetches the server's version.

| The change | When it needs attention | Keep mine |
| --- | --- | --- |
| Move | Someone else moved it since the device copied it | Moves it to your destination |
| Move | The destination location or container was deleted | Not possible |
| Check out | Someone else checked it out, or in, meanwhile | Checks it out to your holder |
| Check out | The holder was deleted | Not possible |
| Check in | It was checked out to someone else meanwhile | Checks it in |
| Any | The item or unit was deleted | Not possible |
| Verify or audit | Some items in it were deleted | Sends it without them |

Some changes the server already reflects are recorded as done without being
sent: a check-out to the holder it is already with, or a check-in of something
already on the shelf. A move the server already reflects is simply sent again,
which changes nothing.

A change the server refuses outright, or one that fails five times in a row with
a server error, also goes to Needs attention, with **Try again** and
**Discard**.

**Nothing is dropped without a person choosing to.** Clearing the offline copy,
or turning the device off, keeps every change that has not been sent yet.

Changes are sent as the person who made them. If someone else signs in on the
device, the first person's changes wait until they sign in again; the new person
sees them listed and can discard them after confirming.

The times recorded on the server for moves and check-outs are when the change
arrived, not when it was made. Field notes keep the time they were written.

## The device panel

**This device** on the Offline screen shows whether the device is online, how
much it holds and how old that is, what is waiting, the last sync and its
outcome, photos waiting to be sent, and the storage the app uses on the device
(including the app's own files). **Clear offline copy** deletes the copy and
keeps the queue. The switch at the top turns working offline off for the device:
its copy and saved session are deleted, and changes already waiting are still
sent.

## Updates

The service worker keeps each build of the app, so it opens offline. A new
deploy installs alongside the running build, and the app shows **A new version
is ready · Reload** instead of switching versions under someone mid-task.
Anything under `/api` and `/auth` always goes to the network: the worker never
answers for data.

The server writes the build's id and file list into `/sw.js` as it serves it,
which is what makes each deploy a new worker. The Vite dev server serves the
file unstamped; it then keeps files as it sees them instead of all at once.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OFFLINE_SNAPSHOT_MAX_ITEMS` | `10000` | Most items one "Make available offline" may copy to a device |

## HTTP API

### Idempotency-Key

Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) made with a
session or an API key accepts an `Idempotency-Key` header, from any client,
following the IETF httpapi Idempotency-Key draft. The middleware is mounted on
the session and API-key router (`server/src/routes/api.ts`), so it does not
cover the routes mounted outside it, which authenticate with their own tokens:
`/api/device/*`, `/api/portal/*`, `/api/claims-portal/*`, `/api/share/*` and
`/api/custody-public/*`. Those ignore the header.

- The key is 1 to 255 visible characters, bare or quoted. A UUID is ideal.
- The first request with a key runs normally. If it succeeds (2xx), its answer
  is stored for 24 hours, scoped to the caller (the signed-in person or the API
  key). A later request from the same caller with the same key gets that answer
  back, with `Idempotent-Replayed: true`, and does not run again.
- A request that fails or is refused changed nothing, so its key is released
  and a retry runs for real.
- The same key on a different request (method, path or body) is a `422` with
  code `idempotency_key_reused`.
- A key whose first request is still running is a `409` with code
  `idempotency_in_progress`; retry shortly.

```bash
curl -X POST https://inventory.example.com/api/items/$ID/checkout \
  -H "x-api-key: bdx_..." -H "content-type: application/json" \
  -H "Idempotency-Key: 5f1c3e0a-7d8b-4f5e-9a51-0c2b1e9d4a77" \
  -d '{"entityId":"..."}'
```

Stored answers live in the `idempotency_keys` table, are pruned after a day and
are not part of backups.

### Offline endpoints

These need a session or API key like the rest of `/api`.

`GET /api/offline/snapshot?locationId=<uuid>` returns the copy described above
for that location, or for the whole instance without `locationId`. `404` when
the feature is switched off; `400` when the scope is over
`OFFLINE_SNAPSHOT_MAX_ITEMS`.

`POST /api/offline/plan` takes `{ "actions": [...] }`, the queued changes with
what the device believed when it made each one, and answers with a verdict per
change: `send`, `skip` (with a reason), `conflict` (with a code, a reason and
whether keep-mine is possible), `blocked` (by an earlier change to the same
record) or `held`. It changes nothing. Up to 2,000 changes per call.

```json
{
  "actions": [
    {
      "id": "c1", "seq": 1, "type": "move",
      "itemId": "...", "to": { "locationId": "..." },
      "base": { "locationId": "..." }
    }
  ]
}
```

Types are `move`, `checkout`, `checkin`, `spot_check`, `verify_apply`,
`audit_apply`, `note` and `photo`. `base.holderId` is the holder of the open
check-out the device saw, `null` for none. `force: true` skips the
changed-since checks (keep-mine); `held: true` marks a change the device is
already holding for a person.

`POST /api/offline/items/:id/notes` with `{ "text": "...", "unitId": null,
"writtenAt": "<ISO time>" }` adds a field note to the item's history.
`GET /api/offline/items/:id/notes` lists them, newest first.

These routes keep working while the feature is switched off, except the
snapshot: a device may still hold changes queued before the switch went off,
and those are always sent. The screens disappear; a device with changes waiting
still shows how many, and sends them.

## Privacy and security

The copy on a device holds the records of the locations it took offline, plus
who was signed in. Anyone holding the unlocked device can read them and, while
offline, use the app as that person, which is the point of the feature; the
server still checks every change when it arrives. Signing out forgets who was
signed in. **Clear offline copy** deletes the copy; turning the device off also
deletes the saved session. When a device starts working offline the app asks the
browser to keep its data even when storage runs low; a browser that declines
may clear it, and the device panel then shows an empty copy.

## Troubleshooting

**The badge says a code is not in the offline copy.** The item is outside every
location the device took offline. Add its location, or scan it again with a
connection.

**The app does not open without a connection.** It needs HTTPS, and it needs to
have been opened once online after offline mode was turned on for the device.

**Changes stay "waiting".** Open the Offline screen: the last sync's outcome is
there, and any change the server refused is under Needs attention. A session
that expired shows "Sign in again"; sign in and they go.
