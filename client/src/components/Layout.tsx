import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, matchPath, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { useConfig } from "../config/useConfig";
import { useBulkCaptureEnabled } from "../features/bulk-capture/shared";
import { ChevronDownIcon, CloseIcon, MenuIcon } from "./icons";

type NavItem = { to: string; label: string; end?: boolean };
type NavGroup = { label: string; links: NavItem[] };

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 text-sm font-medium transition ${
    isActive
      ? "bg-slate-800 text-sky-300"
      : "text-slate-300 hover:bg-slate-800/60 hover:text-slate-100"
  }`;

const menuLinkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm transition ${
    isActive ? "bg-slate-800 text-sky-300" : "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
  }`;

function isLinkActive(pathname: string, link: Pick<NavItem, "to" | "end">) {
  return matchPath({ path: link.to, end: link.end ?? false }, pathname) !== null;
}

/** Closes on an outside click, on Escape, and whenever the route changes. */
function useDisclosure() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, ref };
}

function NavDropdown({ group }: { group: NavGroup }) {
  const { open, setOpen, ref } = useDisclosure();
  const { pathname } = useLocation();
  const active = group.links.some((link) => isLinkActive(pathname, link));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${linkClass({ isActive: active })} flex items-center gap-1`}
      >
        {group.label}
        <ChevronDownIcon className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 min-w-44 rounded-lg border border-slate-800 bg-slate-900 p-1 shadow-xl">
          {group.links.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className={menuLinkClass}>
              {link.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu({ name, email, onSignOut }: { name?: string; email?: string; onSignOut: () => void }) {
  const { open, setOpen, ref } = useDisclosure();
  const { pathname } = useLocation();
  const active = isLinkActive(pathname, { to: "/settings" });

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-sm transition ${
          active ? "bg-slate-800 text-sky-300" : "text-slate-300 hover:bg-slate-800"
        }`}
      >
        <span className="max-w-32 truncate">{name ?? "Account"}</span>
        <ChevronDownIcon className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 min-w-48 rounded-lg border border-slate-800 bg-slate-900 p-1 shadow-xl">
          {email && <div className="truncate px-3 py-2 text-xs text-slate-500">{email}</div>}
          <NavLink to="/settings" className={menuLinkClass}>
            Settings
          </NavLink>
          <button
            type="button"
            onClick={onSignOut}
            className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, signOut } = useAuth();
  const { config } = useConfig();
  const { terms, features } = config;
  const bulkCapture = useBulkCaptureEnabled();
  const mobile = useDisclosure();

  // Built rather than written out so switching a feature off also removes it
  // from the navigation, with no second place to keep in step. The everyday
  // pages stay in the bar; the rest sit in groups so the header stays one row
  // however many features an instance turns on.
  const primary: NavItem[] = [
    { to: "/", label: "Home", end: true },
    { to: "/dashboard", label: "Dashboard" },
    { to: "/items", label: terms.item.plural },
    { to: "/locations", label: terms.location.plural },
    ...(features.holders ? [{ to: "/entities", label: terms.holder.plural }] : []),
  ];

  const groups: NavGroup[] = [
    {
      label: "Field",
      links: [
        ...(features.audit ? [{ to: "/audit", label: "Audit" }] : []),
        ...(features.inspections ? [{ to: "/inspections", label: "Inspections" }] : []),
        ...(features.aiCondition ? [{ to: "/condition", label: "Condition" }] : []),
        ...(bulkCapture ? [{ to: "/capture", label: "Capture" }] : []),
        { to: "/tags", label: "Tags" },
        ...(features.ble ? [{ to: "/ble", label: "Bluetooth" }] : []),
        ...(features.offline ? [{ to: "/offline", label: "Offline" }] : []),
      ],
    },
    {
      label: "Logistics",
      links: [
        ...(features.tracking ? [{ to: "/tracking", label: "Tracking" }] : []),
        ...(features.gps && features.tracking ? [{ to: "/gps", label: "Map" }] : []),
        ...(features.jobs ? [{ to: "/jobs", label: "Jobs" }] : []),
        ...(features.jobs && features.placement ? [{ to: "/placement", label: "Placement" }] : []),
        ...(features.crew ? [{ to: "/crew", label: "Crew" }] : []),
        ...(features.custody ? [{ to: "/custody", label: "Custody" }] : []),
        ...(features.consumables ? [{ to: "/supplies", label: "Supplies" }] : []),
      ],
    },
    {
      label: "Records",
      links: [
        ...(features.domains ? [{ to: "/domains", label: "Domains" }] : []),
        ...(features.documents ? [{ to: "/documents", label: "Documents" }] : []),
        ...(features.valuation ? [{ to: "/valuation", label: "Valuation" }] : []),
        ...(features.teardown ? [{ to: "/teardown", label: "Teardowns" }] : []),
        ...(features.claims ? [{ to: "/claims", label: "Claims" }] : []),
        ...(features.opsIntel ? [{ to: "/insights", label: "Insights" }] : []),
        ...(features.portal && user?.role === "admin" ? [{ to: "/portal", label: "Portal" }] : []),
      ],
    },
  ].filter((group) => group.links.length > 0);

  return (
    <div className="min-h-screen">
      <header ref={mobile.ref} className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <NavLink to="/" className="mr-2 flex shrink-0 items-center gap-2">
            <img src="/icon.svg" alt="" className="h-7 w-7" />
            <span className="hidden font-semibold text-slate-100 sm:inline">{config.appName}</span>
          </NavLink>
          <nav className="hidden flex-1 items-center gap-1 lg:flex">
            {primary.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={linkClass}>
                {link.label}
              </NavLink>
            ))}
            {groups.map((group) => (
              <NavDropdown key={group.label} group={group} />
            ))}
          </nav>
          <div className="ml-auto hidden lg:block">
            <UserMenu name={user?.name} email={user?.email} onSignOut={signOut} />
          </div>
          <button
            type="button"
            aria-label={mobile.open ? "Close menu" : "Open menu"}
            aria-expanded={mobile.open}
            onClick={() => mobile.setOpen((o) => !o)}
            className="ml-auto rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800 lg:hidden"
          >
            {mobile.open ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
          </button>
        </div>
        {mobile.open && (
          <nav className="max-h-[calc(100vh-4rem)] overflow-y-auto border-t border-slate-800 px-4 pb-4 lg:hidden">
            <div className="mx-auto max-w-5xl">
              <div className="grid grid-cols-2 gap-1 pt-3 sm:grid-cols-3">
                {primary.map((link) => (
                  <NavLink key={link.to} to={link.to} end={link.end} className={menuLinkClass}>
                    {link.label}
                  </NavLink>
                ))}
              </div>
              {groups.map((group) => (
                <div key={group.label} className="pt-3">
                  <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {group.label}
                  </div>
                  <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                    {group.links.map((link) => (
                      <NavLink key={link.to} to={link.to} end={link.end} className={menuLinkClass}>
                        {link.label}
                      </NavLink>
                    ))}
                  </div>
                </div>
              ))}
              <div className="mt-3 flex items-center gap-2 border-t border-slate-800 pt-3">
                <span className="flex-1 truncate px-3 text-sm text-slate-400" title={user?.email}>
                  {user?.name}
                </span>
                <NavLink to="/settings" className={linkClass}>
                  Settings
                </NavLink>
                <button
                  type="button"
                  onClick={signOut}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Sign out
                </button>
              </div>
            </div>
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 pb-24">
        <Outlet />
      </main>
    </div>
  );
}
