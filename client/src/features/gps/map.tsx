import { useEffect, useState, type DependencyList } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { gpsApi } from "./api";
import type { Geofence, MapConfig, TrackerStatus } from "./types";

/**
 * Leaflet, wrapped just enough for React. Maps are imperative, so a screen
 * gets the map instance from useLeafletMap and draws into layer groups with
 * useLayer, which clears them when their inputs change. Markers are drawn as
 * circles, not image pins, so nothing depends on Leaflet's icon files.
 *
 * Anything a person typed (names, notes) goes onto the map as text nodes:
 * Leaflet treats a string tooltip or popup as HTML.
 */

let configPromise: Promise<MapConfig> | null = null;

/** Tile server and defaults, fetched once per page load. */
export function useMapConfig(): { config: MapConfig | null; error: string | null } {
  const [config, setConfig] = useState<MapConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    configPromise ??= gpsApi.config().catch((err) => {
      configPromise = null;
      throw err;
    });
    let live = true;
    configPromise
      .then((c) => live && setConfig(c))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Could not load the map settings."));
    return () => {
      live = false;
    };
  }, []);
  return { config, error };
}

/** A map in the element the returned ref is attached to. */
export function useLeafletMap(config: MapConfig | null): { ref: (el: HTMLDivElement | null) => void; map: L.Map | null } {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  useEffect(() => {
    if (!el || !config) return;
    const m = L.map(el, { worldCopyJump: true }).setView([20, 0], 2);
    L.tileLayer(config.tileUrl, { attribution: config.attribution, maxZoom: config.maxZoom }).addTo(m);
    setMap(m);
    return () => {
      setMap(null);
      m.remove();
    };
  }, [el, config]);
  return { ref: setEl, map };
}

/** Draw into a fresh layer group whenever `deps` change; the old one is removed. */
export function useLayer(map: L.Map | null, draw: (group: L.LayerGroup, map: L.Map) => void, deps: DependencyList) {
  useEffect(() => {
    if (!map) return;
    const group = L.layerGroup().addTo(map);
    draw(group, map);
    return () => {
      group.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ...deps]);
}

/** Text for a tooltip or popup, never parsed as HTML. */
export function text(...lines: (string | null | undefined)[]): HTMLElement {
  const el = document.createElement("div");
  lines
    .filter((l): l is string => Boolean(l))
    .forEach((line, i) => {
      const span = document.createElement(i === 0 ? "strong" : "span");
      span.textContent = line;
      span.style.display = "block";
      el.appendChild(span);
    });
  return el;
}

/** Longitudes made continuous along a ring, so Leaflet draws a fence across the antimeridian as one shape. */
export function unwrap(ring: [number, number][]): L.LatLngTuple[] {
  const out: L.LatLngTuple[] = [];
  for (const [lng, lat] of ring) {
    const prev = out[out.length - 1];
    if (!prev) out.push([lat, lng]);
    else {
      const d = ((((lng - prev[1] + 180) % 360) + 360) % 360) - 180;
      out.push([lat, prev[1] + d]);
    }
  }
  return out;
}

export const FENCE_COLOR = "#0ea5e9";

/** A fence as a Leaflet layer. */
export function fenceLayer(f: Pick<Geofence, "kind" | "geometry" | "radiusM" | "color" | "active">, opts: L.PathOptions = {}): L.Path {
  const style: L.PathOptions = {
    color: f.color ?? FENCE_COLOR,
    weight: 2,
    fillOpacity: 0.12,
    dashArray: f.active ? undefined : "6 6",
    ...opts,
  };
  if (f.geometry.type === "Point") {
    const [lng, lat] = f.geometry.coordinates;
    return L.circle([lat, lng], { ...style, radius: f.radiusM ?? 0 });
  }
  return L.polygon(
    f.geometry.coordinates.map((ring) => unwrap(ring)),
    style,
  );
}

export const STATUS_COLORS: Record<TrackerStatus, string> = {
  available: "#10b981",
  assigned: "#0ea5e9",
  awaiting_return: "#f59e0b",
  disposed: "#64748b",
};

/** A fence's extent, without having to add it to a map first. */
export function fenceBounds(f: Pick<Geofence, "geometry" | "radiusM">): L.LatLngBounds {
  if (f.geometry.type === "Point") {
    const [lng, lat] = f.geometry.coordinates;
    return L.latLng(lat, lng).toBounds((f.radiusM ?? 0) * 2);
  }
  return L.latLngBounds(unwrap(f.geometry.coordinates[0] ?? []));
}

/** Zoom to fit, or leave the view alone when there is nothing to fit. */
export function fitTo(map: L.Map, bounds: (L.LatLngBounds | L.LatLngExpression)[], maxZoom = 16) {
  let all: L.LatLngBounds | null = null;
  for (const b of bounds) {
    const box = b instanceof L.LatLngBounds ? b : L.latLngBounds([b]);
    if (!box.isValid()) continue;
    all = all ? all.extend(box) : box;
  }
  if (all) map.fitBounds(all.pad(0.2), { maxZoom });
}

/** The map element's size and frame. */
export const MAP_CLASS = "h-[26rem] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-900 sm:h-[32rem]";
