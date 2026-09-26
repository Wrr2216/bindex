import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { useConfig } from "../config/useConfig";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 text-sm font-medium transition ${
    isActive
      ? "bg-slate-800 text-sky-300"
      : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
  }`;

export function Layout() {
  const { user, signOut } = useAuth();
  const { config } = useConfig();
  const { terms, features } = config;

  // Built rather than written out so switching a feature off also removes it
  // from the navigation, with no second place to keep in step.
  const links: { to: string; label: string; end?: boolean }[] = [
    { to: "/", label: "Home", end: true },
    { to: "/dashboard", label: "Dashboard" },
    { to: "/items", label: terms.item.plural },
    ...(features.domains ? [{ to: "/domains", label: "Domains" }] : []),
    { to: "/locations", label: terms.location.plural },
    ...(features.holders ? [{ to: "/entities", label: terms.holder.plural }] : []),
    ...(features.audit ? [{ to: "/audit", label: "Audit" }] : []),
    ...(features.tracking ? [{ to: "/tracking", label: "Tracking" }] : []),
    ...(features.jobs ? [{ to: "/jobs", label: "Jobs" }] : []),
    ...(features.consumables ? [{ to: "/supplies", label: "Supplies" }] : []),
    { to: "/tags", label: "Tags" },
    { to: "/settings", label: "Settings" },
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <NavLink to="/" className="mr-2 flex items-center gap-2">
            <img src="/icon.svg" alt="" className="h-7 w-7" />
            <span className="hidden font-semibold text-slate-100 sm:inline">{config.appName}</span>
          </NavLink>
          <nav className="flex flex-1 flex-wrap items-center gap-1">
            {links.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={linkClass}>
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-slate-400 sm:inline" title={user?.email}>
              {user?.name}
            </span>
            <button
              onClick={signOut}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 pb-24">
        <Outlet />
      </main>
    </div>
  );
}
