import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import L from "leaflet";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Field, Toggle } from "../../components/ui";
import type { Location } from "../../types";
import { ZonePicker } from "../tracking-core/ZonePicker";
import { gpsApi } from "./api";
import { dateTime, distance, errorText } from "./format";
import { GpsNav } from "./GpsNav";
import { FENCE_COLOR, MAP_CLASS, fenceBounds, fenceLayer, fitTo, text, useLayer, useLeafletMap, useMapConfig } from "./map";
import type { Geofence, GeofenceEvent, GeofenceGeometry, GeofenceKind } from "./types";

type Draft = {
  name: string;
  kind: GeofenceKind;
  center: L.LatLng | null;
  radiusM: string;
  corners: L.LatLng[];
  locationId: string | null;
  dwellSeconds: string;
  color: string;
  notes: string;
  active: boolean;
};

const EMPTY: Draft = {
  name: "",
  kind: "circle",
  center: null,
  radiusM: "200",
  corners: [],
  locationId: null,
  dwellSeconds: "30",
  color: FENCE_COLOR,
  notes: "",
  active: true,
};

function draftOf(f: Geofence): Draft {
  const g = f.geometry;
  return {
    name: f.name,
    kind: f.kind,
    center: g.type === "Point" ? L.latLng(g.coordinates[1], g.coordinates[0]) : null,
    radiusM: String(f.radiusM ?? 200),
    corners: g.type === "Polygon" ? (g.coordinates[0] ?? []).slice(0, -1).map(([lng, lat]) => L.latLng(lat, lng)) : [],
    locationId: f.locationId,
    dwellSeconds: String(f.dwellSeconds),
    color: f.color ?? FENCE_COLOR,
    notes: f.notes ?? "",
    active: f.active,
  };
}

function geometryOf(d: Draft): GeofenceGeometry | null {
  if (d.kind === "circle") return d.center ? { type: "Point", coordinates: [d.center.lng, d.center.lat] } : null;
  if (d.corners.length < 3) return null;
  const ring = d.corners.map((c) => [c.lng, c.lat] as [number, number]);
  return { type: "Polygon", coordinates: [[...ring, ring[0]!]] };
}

const handleIcon = (color: string) =>
  L.divIcon({
    className: "",
    // The colour goes into markup, so only a plain hex colour is let through.
    html: `<span style="display:block;width:14px;height:14px;border-radius:9999px;border:2px solid #fff;background:${
      /^#[0-9a-fA-F]{6}$/.test(color) ? color : FENCE_COLOR
    }"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

/**
 * Geofences: draw a circle or a polygon around a yard, a site or a depot, link
 * it to a location, and choose how long a tracker must stay across its edge
 * before it counts. Administrators edit; everyone else can look.
 */
export function GeofencesPage() {
  const terms = useTerms();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { config, error: configError } = useMapConfig();
  const { ref, map } = useLeafletMap(config);
  const [fences, setFences] = useState<Geofence[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<Geofence | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<GeofenceEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fitted = useRef(false);

  const load = useCallback(async () => {
    try {
      setFences(await gpsApi.geofences(true));
    } catch (err) {
      setError(errorText(err, "Could not load geofences."));
      setFences([]);
    }
  }, []);

  useEffect(() => {
    void load();
    api.listLocations().then(setLocations).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!selected) return setEvents([]);
    let live = true;
    gpsApi
      .events({ geofenceId: selected, limit: 20 })
      .then((r) => live && setEvents(r.events))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [selected]);

  const editingId = editing && editing !== "new" ? editing.id : null;

  // Every stored fence; the one being edited is drawn from the draft instead.
  useLayer(
    map,
    (group, m) => {
      for (const f of fences ?? []) {
        if (f.id === editingId) continue;
        fenceLayer(f, { opacity: editing ? 0.4 : 1, fillOpacity: f.id === selected ? 0.25 : 0.1 })
          .bindTooltip(text(f.name, f.locationName, f.active ? null : "Switched off"))
          .on("click", () => !editing && setSelected(f.id))
          .addTo(group);
      }
      if (!fitted.current && fences?.length) {
        fitted.current = true;
        fitTo(m, fences.map(fenceBounds));
      }
    },
    [fences, editingId, editing !== null, selected],
  );

  // The draft, with handles to drag.
  useLayer(
    map,
    (group) => {
      if (!editing) return;
      const color = draft.color || FENCE_COLOR;
      if (draft.kind === "circle" && draft.center) {
        const radius = Number(draft.radiusM) || 0;
        L.circle(draft.center, { radius, color, weight: 2, fillOpacity: 0.15 }).addTo(group);
        L.marker(draft.center, { draggable: true, icon: handleIcon(color), title: "Centre" })
          .on("dragend", (e) => setDraft((d) => ({ ...d, center: (e.target as L.Marker).getLatLng().wrap() })))
          .addTo(group);
      }
      if (draft.kind === "polygon" && draft.corners.length) {
        if (draft.corners.length >= 3) L.polygon(draft.corners, { color, weight: 2, fillOpacity: 0.15 }).addTo(group);
        else L.polyline(draft.corners, { color, weight: 2, dashArray: "4 4" }).addTo(group);
        draft.corners.forEach((c, i) =>
          L.marker(c, { draggable: true, icon: handleIcon(color), title: `Corner ${i + 1}` })
            .on("dragend", (e) => {
              const at = (e.target as L.Marker).getLatLng().wrap();
              setDraft((d) => ({ ...d, corners: d.corners.map((x, j) => (j === i ? at : x)) }));
            })
            .addTo(group),
        );
      }
    },
    [editing, draft],
  );

  // Clicking the map places the centre, or adds a corner.
  useEffect(() => {
    if (!map || !editing) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      const at = e.latlng.wrap();
      setDraft((d) => (d.kind === "circle" ? { ...d, center: at } : { ...d, corners: [...d.corners, at] }));
    };
    map.on("click", onClick);
    map.getContainer().style.cursor = "crosshair";
    return () => {
      map.off("click", onClick);
      map.getContainer().style.cursor = "";
    };
  }, [map, editing]);

  const start = (f: Geofence | "new") => {
    setEditing(f);
    setDraft(f === "new" ? EMPTY : draftOf(f));
    setError(null);
    setMessage(null);
    if (f !== "new" && map) fitTo(map, [fenceBounds(f)]);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const geometry = geometryOf(draft);
    if (!draft.name.trim()) return setError("Give the geofence a name.");
    if (!geometry) {
      return setError(
        draft.kind === "circle" ? "Click the map to place the centre." : "Click the map to add at least three corners.",
      );
    }
    const radius = Number(draft.radiusM);
    if (draft.kind === "circle" && !(radius > 0)) return setError("The radius must be more than zero metres.");
    const dwell = Number(draft.dwellSeconds);
    if (!Number.isInteger(dwell) || dwell < 0 || dwell > 86_400) {
      return setError("The dwell time is a whole number of seconds, up to 86400.");
    }
    const input = {
      name: draft.name.trim(),
      kind: draft.kind,
      geometry,
      radiusM: draft.kind === "circle" ? radius : null,
      locationId: draft.locationId,
      dwellSeconds: dwell,
      color: /^#[0-9a-fA-F]{6}$/.test(draft.color) ? draft.color : null,
      notes: draft.notes.trim() || null,
      active: draft.active,
    };
    setBusy(true);
    setError(null);
    try {
      const saved = editing === "new" ? await gpsApi.createGeofence(input) : await gpsApi.updateGeofence(editing.id, input);
      setMessage(`Saved ${saved.name}.`);
      setEditing(null);
      setSelected(saved.id);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not save the geofence."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: Geofence) => {
    if (!window.confirm(`Delete “${f.name}”? Its crossings stay in history.`)) return;
    try {
      await gpsApi.deleteGeofence(f.id);
      setEditing(null);
      setSelected(null);
      setMessage(`Deleted ${f.name}.`);
      await load();
    } catch (err) {
      setError(errorText(err, "Could not delete the geofence."));
    }
  };

  const locationWord = terms.location.singular.toLowerCase();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Geofences</h1>
        <GpsNav />
      </div>
      <p className="text-sm text-slate-400">
        A geofence outlines a yard, site or depot. Trackers entering and leaving it are recorded and announced, a
        shipment leaving its origin goes in transit, and one entering its destination asks for delivery to be
        confirmed. Link a fence to a {locationWord} so {terms.item.plural.toLowerCase()} whose tracker moves them are
        put there.
      </p>

      {(configError || error) && <p className="text-sm text-red-400">{configError ?? error}</p>}
      {message && <p className="text-sm text-slate-400">{message}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div ref={ref} className={MAP_CLASS} role="region" aria-label="Geofence map" />

        <div className="space-y-3">
          {editing ? (
            <form onSubmit={save} className="space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-4">
              <h2 className="font-semibold text-slate-100">{editing === "new" ? "New geofence" : `Edit ${editing.name}`}</h2>
              <Field label="Name">
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={FIELD} placeholder="North yard" />
              </Field>
              <div className="flex gap-2" role="radiogroup" aria-label="Shape">
                {(["circle", "polygon"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={draft.kind === k}
                    onClick={() => setDraft({ ...draft, kind: k })}
                    className={`flex-1 rounded-lg border px-3 py-1.5 text-sm ${
                      draft.kind === k ? "border-sky-600 bg-sky-950 text-sky-200" : "border-slate-700 text-slate-300"
                    }`}
                  >
                    {k === "circle" ? "Circle" : "Polygon"}
                  </button>
                ))}
              </div>
              {draft.kind === "circle" ? (
                <>
                  <p className="text-xs text-slate-500">
                    {draft.center ? "Drag the centre, or click the map to move it." : "Click the map to place the centre."}
                  </p>
                  <Field label="Radius (metres)">
                    <input
                      value={draft.radiusM}
                      onChange={(e) => setDraft({ ...draft, radiusM: e.target.value })}
                      inputMode="numeric"
                      className={FIELD}
                    />
                  </Field>
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500">
                    Click the map to add corners in order; drag a corner to move it. {draft.corners.length} corner
                    {draft.corners.length === 1 ? "" : "s"} so far.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, corners: draft.corners.slice(0, -1) })}
                      disabled={!draft.corners.length}
                      className={BUTTON_QUIET}
                    >
                      Undo corner
                    </button>
                    <button type="button" onClick={() => setDraft({ ...draft, corners: [] })} disabled={!draft.corners.length} className={BUTTON_QUIET}>
                      Clear
                    </button>
                  </div>
                </div>
              )}
              <Field label={`Linked ${locationWord}`} hint={`Optional. A tracker inside the fence is in this ${locationWord}.`}>
                <ZonePicker
                  locations={locations}
                  value={draft.locationId}
                  onChange={(locationId) => setDraft({ ...draft, locationId })}
                  label={`Linked ${locationWord}`}
                  emptyLabel="None"
                />
              </Field>
              <Field label="Dwell (seconds)" hint="How long a tracker must stay across the edge before it counts. 0 counts the first fix.">
                <input
                  value={draft.dwellSeconds}
                  onChange={(e) => setDraft({ ...draft, dwellSeconds: e.target.value })}
                  inputMode="numeric"
                  className={FIELD}
                />
              </Field>
              <Field label="Colour">
                <input type="color" value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} className="h-9 w-16 rounded" />
              </Field>
              <Field label="Notes">
                <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={2} className={FIELD} />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Active</span>
                <Toggle label="Active" checked={draft.active} onChange={(active) => setDraft({ ...draft, active })} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className={BUTTON}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={() => setEditing(null)} className={BUTTON_QUIET}>
                  Cancel
                </button>
                {editing !== "new" && (
                  <button
                    type="button"
                    onClick={() => void remove(editing)}
                    className="rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950"
                  >
                    Delete
                  </button>
                )}
              </div>
            </form>
          ) : (
            isAdmin && (
              <button type="button" onClick={() => start("new")} className={BUTTON}>
                New geofence
              </button>
            )
          )}

          {fences === null ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : fences.length === 0 ? (
            <p className="text-sm text-slate-400">No geofences yet.</p>
          ) : (
            <ul className="space-y-2">
              {fences.map((f) => (
                <li
                  key={f.id}
                  className={`rounded-xl border p-3 ${f.id === selected ? "border-sky-700 bg-slate-800" : "border-slate-800 bg-slate-900"}`}
                >
                  <button type="button" onClick={() => setSelected(f.id)} className="block w-full text-left">
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: f.color ?? FENCE_COLOR }} aria-hidden />
                      <span className="font-medium text-slate-100">{f.name}</span>
                      {!f.active && <span className="rounded-full bg-slate-800 px-2 text-xs text-slate-400">Off</span>}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {f.kind === "circle" ? `Circle, ${distance(f.radiusM)} radius` : `Polygon, ${(f.areaM2 / 10_000).toFixed(1)} ha`}
                      {` · dwell ${f.dwellSeconds} s`}
                    </span>
                    {f.locationName && <span className="block text-xs text-slate-400">{f.locationName}</span>}
                  </button>
                  {isAdmin && !editing && (
                    <button type="button" onClick={() => start(f)} className="mt-2 text-xs text-sky-400 hover:underline">
                      Edit
                    </button>
                  )}
                  {f.id === selected && events.length > 0 && (
                    <ul className="mt-2 space-y-0.5 border-t border-slate-800 pt-2 text-xs">
                      {events.map((e) => (
                        <li key={e.id} className="flex justify-between gap-2">
                          <span className={e.kind === "entered" ? "text-emerald-400" : "text-amber-400"}>
                            {e.kind === "entered" ? "In" : "Out"}: {e.deviceName ?? "Tracker"}
                          </span>
                          <span className="text-slate-500">{dateTime(e.occurredAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
