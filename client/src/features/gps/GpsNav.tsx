import { NavLink } from "react-router-dom";

const tab = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm ${isActive ? "bg-slate-800 text-sky-300" : "text-slate-300 hover:bg-slate-800/60"}`;

/** Tabs across the GPS screens. */
export function GpsNav() {
  return (
    <nav className="flex flex-wrap gap-1" aria-label="GPS">
      <NavLink to="/gps" end className={tab}>
        Live map
      </NavLink>
      <NavLink to="/gps/trackers" className={tab}>
        Trackers
      </NavLink>
      <NavLink to="/gps/geofences" className={tab}>
        Geofences
      </NavLink>
    </nav>
  );
}
