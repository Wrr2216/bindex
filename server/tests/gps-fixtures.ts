/**
 * A recorded delivery run, as a GPS logger exports it: a truck parked at the
 * warehouse (51.5000, -0.1000), driving about 5 km east at 43 km/h, and
 * parked at the site (51.5000, -0.0280). Two things real uplinks do are left
 * in: one multipath glitch 11 km north, and one fix buffered during the drive
 * and delivered after arrival.
 */
export const DELIVERY_RUN_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Bindex test fixture" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Warehouse to site</name>
    <trkseg>
      <trkpt lat="51.500000" lon="-0.100000"><ele>12</ele><time>2026-09-26T08:00:00Z</time></trkpt>
      <trkpt lat="51.500030" lon="-0.100020"><ele>12</ele><time>2026-09-26T08:00:30Z</time></trkpt>
      <trkpt lat="51.499980" lon="-0.099960"><ele>12</ele><time>2026-09-26T08:01:00Z</time></trkpt>
      <trkpt lat="51.500010" lon="-0.099990"><ele>12</ele><time>2026-09-26T08:01:30Z</time></trkpt>
      <trkpt lat="51.500089" lon="-0.094857"><ele>12</ele><time>2026-09-26T08:02:00Z</time></trkpt>
      <trkpt lat="51.500174" lon="-0.089714"><ele>12</ele><time>2026-09-26T08:02:30Z</time></trkpt>
      <trkpt lat="51.500249" lon="-0.084571"><ele>12</ele><time>2026-09-26T08:03:00Z</time></trkpt>
      <trkpt lat="51.500313" lon="-0.079429"><ele>12</ele><time>2026-09-26T08:03:30Z</time></trkpt>
      <trkpt lat="51.500360" lon="-0.074286"><ele>12</ele><time>2026-09-26T08:04:00Z</time></trkpt>
      <trkpt lat="51.500390" lon="-0.069143"><ele>12</ele><time>2026-09-26T08:04:30Z</time></trkpt>
      <!-- glitch -->
      <trkpt lat="51.602100" lon="-0.061200"><ele>12</ele><time>2026-09-26T08:04:40Z</time></trkpt>
      <trkpt lat="51.500400" lon="-0.064000"><ele>12</ele><time>2026-09-26T08:05:00Z</time></trkpt>
      <trkpt lat="51.500390" lon="-0.058857"><ele>12</ele><time>2026-09-26T08:05:30Z</time></trkpt>
      <trkpt lat="51.500360" lon="-0.053714"><ele>12</ele><time>2026-09-26T08:06:00Z</time></trkpt>
      <trkpt lat="51.500313" lon="-0.048571"><ele>12</ele><time>2026-09-26T08:06:30Z</time></trkpt>
      <trkpt lat="51.500249" lon="-0.043429"><ele>12</ele><time>2026-09-26T08:07:00Z</time></trkpt>
      <trkpt lat="51.500174" lon="-0.038286"><ele>12</ele><time>2026-09-26T08:07:30Z</time></trkpt>
      <trkpt lat="51.500089" lon="-0.033143"><ele>12</ele><time>2026-09-26T08:08:00Z</time></trkpt>
      <trkpt lat="51.500000" lon="-0.028000"><ele>12</ele><time>2026-09-26T08:08:30Z</time></trkpt>
      <trkpt lat="51.500000" lon="-0.028000"><ele>12</ele><time>2026-09-26T08:09:00Z</time></trkpt>
      <trkpt lat="51.500030" lon="-0.028020"><ele>12</ele><time>2026-09-26T08:09:30Z</time></trkpt>
      <trkpt lat="51.499980" lon="-0.027960"><ele>12</ele><time>2026-09-26T08:10:00Z</time></trkpt>
      <trkpt lat="51.500010" lon="-0.027990"><ele>12</ele><time>2026-09-26T08:10:30Z</time></trkpt>
      <!-- buffered during the drive, delivered late -->
      <trkpt lat="51.500360" lon="-0.074286"><ele>12</ele><time>2026-09-26T08:03:55Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

export const WAREHOUSE = { lat: 51.5, lng: -0.1 };
export const SITE = { lat: 51.5, lng: -0.028 };
/** A depot on the way, passed at 08:05:30. */
export const DEPOT = { lat: 51.50039, lng: -0.058857 };

export type GpxPoint = { lat: number; lng: number; ele: number | null; time: Date };

/** The track points of a GPX file, in file order. Enough of GPX for a fixture. */
export function parseGpx(gpx: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  const re = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*>([\s\S]*?)<\/trkpt>/g;
  for (let m = re.exec(gpx); m; m = re.exec(gpx)) {
    const body = m[3]!;
    const time = /<time>([^<]+)<\/time>/.exec(body)?.[1];
    const ele = /<ele>([^<]+)<\/ele>/.exec(body)?.[1];
    if (!time) continue;
    points.push({ lat: Number(m[1]), lng: Number(m[2]), ele: ele ? Number(ele) : null, time: new Date(time) });
  }
  return points;
}
