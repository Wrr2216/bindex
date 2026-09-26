import { Link } from "react-router-dom";
import { useFeatures } from "../../config/useConfig";

/** A shipment's live map and delivery sign-off, when those features are on. */
export function ShipmentLinks({ shipmentId }: { shipmentId: string }) {
  const f = useFeatures();
  const id = encodeURIComponent(shipmentId);
  const links: { to: string; label: string }[] = [
    ...(f.gps ? [{ to: `/gps/shipments/${id}`, label: "Map" }] : []),
    ...(f.custody ? [{ to: `/custody/shipments/${id}/sign-off`, label: "Delivery sign-off" }] : []),
  ];
  return (
    <>
      {links.map((l) => (
        <Link
          key={l.to}
          to={l.to}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          {l.label}
        </Link>
      ))}
    </>
  );
}
