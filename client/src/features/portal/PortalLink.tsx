import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { useScannerListener } from "../../scan/useScannerListener";
// Direct file imports rather than the feature index: the index also brings the
// staff galleries and label reading, which a portal visitor never uses.
import { Modal } from "../media-ai-core/Modal";
import { SignaturePad } from "../media-ai-core/SignaturePad";
import { play, primeAudio } from "../jobs-core/sound";
import { portalClient, type PortalClient } from "./api";
import { useFeatures } from "../../config/useConfig";
import { PortalClaimPanel } from "../claims";
import type {
  FlaggedPage,
  HandoffReceipt,
  LineDetail,
  LineFilter,
  LinePage,
  NoteCondition,
  PortalDocuments,
  PortalLine,
  PortalOverview,
  PortalSession,
  PortalShipment,
  ScanResult,
} from "./types";
import {
  AccentButton,
  BTN_QUIET,
  CARD,
  Chip,
  FIELD,
  H2,
  Notice,
  PortalImage,
  PortalUiContext,
  ProgressBar,
  StageBadge,
  StepBars,
  errorText,
  fmtDate,
  fmtDateTime,
  formatBytes,
  openPortalFile,
  usePortalUi,
  words,
} from "./ui";

const CameraScanner = lazy(() => import("../../scan/CameraScanner").then((m) => ({ default: m.CameraScanner })));

/**
 * The page behind a portal link, /p/<token>. Rendered outside the sign-in
 * gate: whoever holds the link sees what it grants and nothing else, and the
 * server enforces that on every request. Mobile first; branded with the
 * instance's name and colour.
 */
export function PortalLinkPage() {
  return (
    <Routes>
      <Route path="/p/:token/*" element={<PortalFromParams />} />
    </Routes>
  );
}

function PortalFromParams() {
  const { token = "" } = useParams();
  return <PortalApp key={token} token={token} />;
}

const passKey = (token: string) => `bindex.portal.pass.${token.slice(-16)}`;

function readPass(token: string): string | null {
  try {
    return localStorage.getItem(passKey(token));
  } catch {
    return null;
  }
}

function writePass(token: string, pass: string | null) {
  try {
    if (pass) localStorage.setItem(passKey(token), pass);
    else localStorage.removeItem(passKey(token));
  } catch {
    // Private browsing: the code will be asked for again next time.
  }
}

const LINK_ERRORS = new Set(["link_invalid", "link_expired", "link_revoked", "portal_unavailable", "rate_limited"]);

function PortalApp({ token }: { token: string }) {
  const client = useMemo(() => portalClient(token, () => readPass(token)), [token]);
  const [session, setSession] = useState<PortalSession | null>(null);
  const [fatal, setFatal] = useState<{ code: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSession(await client.session());
    } catch (err) {
      if (err instanceof ApiError && LINK_ERRORS.has(err.code)) setFatal({ code: err.code, message: err.message });
      else setFatal({ code: "error", message: errorText(err, "The portal could not be reached. Check your connection and reload.") });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (session) document.title = session.scope ? `${session.scope.name} · ${session.instance.appName}` : session.instance.appName;
  }, [session]);

  // A pass that has lapsed, or a link revoked mid-visit, surfaces on any call.
  const onAuthError = useCallback(
    (err: unknown) => {
      if (!(err instanceof ApiError)) return false;
      if (err.code === "code_required") {
        writePass(token, null);
        void load();
        return true;
      }
      if (LINK_ERRORS.has(err.code)) {
        setFatal({ code: err.code, message: err.message });
        return true;
      }
      return false;
    },
    [load, token],
  );

  if (fatal) return <Closed code={fatal.code} message={fatal.message} />;
  if (!session) return <p className="p-6 text-center text-slate-400">Loading…</p>;

  const ui = {
    client,
    accent: session.instance.accentColor || "#0284c7",
    stages: session.stages,
    locale: session.instance.locale,
    currency: session.instance.currency,
  };

  return (
    <PortalUiContext.Provider value={ui}>
      {session.codeRequired && !session.verified ? (
        <CodeGate
          session={session}
          onVerified={(pass) => {
            writePass(token, pass);
            void load();
          }}
        />
      ) : (
        <Shell token={token} session={session} setSession={setSession} onAuthError={onAuthError} />
      )}
    </PortalUiContext.Provider>
  );
}

function Closed({ code, message }: { code: string; message: string }) {
  const title =
    code === "link_expired"
      ? "This link has expired"
      : code === "link_revoked"
        ? "This link has been switched off"
        : code === "portal_unavailable"
          ? "The portal is not available"
          : code === "rate_limited"
            ? "Too many attempts"
            : code === "link_invalid"
              ? "This link does not work"
              : "Something went wrong";
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
      <p className="text-sm text-slate-400">{message}</p>
    </main>
  );
}

function Brand({ session }: { session: PortalSession }) {
  const { accent } = usePortalUi();
  const name = session.instance.orgName || session.instance.appName;
  return (
    <div className="flex items-center gap-2">
      <span className="h-6 w-1.5 rounded-full" style={{ backgroundColor: accent }} aria-hidden />
      <span className="font-semibold text-slate-100">{name}</span>
    </div>
  );
}

function CodeGate({ session, onVerified }: { session: PortalSession; onVerified: (pass: string) => void }) {
  const { client } = usePortalUi();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  const send = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await client.sendCode();
      setSent(true);
      setMessage({ tone: "ok", text: `We sent a six-digit code to ${session.email}. It works for 10 minutes.` });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { pass } = await client.verifyCode(code);
      onVerified(pass);
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <Brand session={session} />
      <h1 className="text-xl font-semibold text-slate-100">Confirm it is you</h1>
      <p className="text-sm text-slate-400">
        This link is for {session.granteeName}. To open it on this device, enter the code we email to {session.email}.
      </p>
      {!sent ? (
        <AccentButton onClick={send} disabled={busy}>
          {busy ? "Sending…" : "Email me a code"}
        </AccentButton>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-3">
          <input
            className={`${FIELD} text-center text-2xl tracking-[0.4em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="000000"
            aria-label="Code"
            autoFocus
          />
          <AccentButton type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6}>
            {busy ? "Checking…" : "Open"}
          </AccentButton>
          <button type="button" onClick={send} disabled={busy} className="text-sm text-slate-400 hover:text-slate-200">
            Send a new code
          </button>
        </form>
      )}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </main>
  );
}

// ---- The page once open ------------------------------------------------------------

type ShellProps = {
  token: string;
  session: PortalSession;
  setSession: (s: PortalSession) => void;
  onAuthError: (err: unknown) => boolean;
};

const REFRESH_MS = 60_000;

/** Overview data shared by the tabs, refreshed every minute while the page is visible. */
function useOverview(onAuthError: (err: unknown) => boolean) {
  const { client } = usePortalUi();
  const [overview, setOverview] = useState<PortalOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setOverview(await client.overview());
      setError(null);
    } catch (err) {
      if (!onAuthError(err)) setError(errorText(err));
    }
  }, [client, onAuthError]);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return { overview, error, reload };
}

function Shell({ token, session, setSession, onAuthError }: ShellProps) {
  const { accent } = usePortalUi();
  const { overview, error, reload } = useOverview(onAuthError);
  const [openLine, setOpenLine] = useState<string | null>(null);
  const contributor = session.role === "contributor" && session.contributor;
  const base = `/p/${token}`;
  // Claims answers for itself whether this link may file one; the tab only
  // needs to know the feature exists.
  const claims = useFeatures().claims;
  const getPass = useCallback(() => readPass(token), [token]);
  // A crew is here to scan, so that tab comes straight after the overview.
  const tabs = [
    { to: base, label: "Overview", end: true },
    ...(contributor ? [{ to: `${base}/scan`, label: "Scan" }] : []),
    { to: `${base}/items`, label: session.instance.itemTerm.plural },
    { to: `${base}/flagged`, label: "Flagged" },
    { to: `${base}/documents`, label: "Documents" },
    ...(claims ? [{ to: `${base}/report`, label: "Report a problem" }] : []),
  ];
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    // On a narrow phone the tabs scroll; keep the current one in view.
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <div className="min-h-screen pb-24">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900/95 backdrop-blur" style={{ borderTopColor: accent, borderTopWidth: 3 }}>
        <div className="mx-auto max-w-3xl px-4 pt-3">
          <div className="flex items-center justify-between gap-2">
            <Brand session={session} />
            <span className="truncate text-xs text-slate-400">
              {session.role === "contributor" ? "Crew link" : "Viewer"} · {session.granteeName}
            </span>
          </div>
          {session.scope && (
            <h1 className="mt-2 text-lg font-semibold text-slate-100">
              {session.scope.name} <span className="text-sm font-normal text-slate-400">{session.scope.code}</span>
            </h1>
          )}
          <nav ref={nav} className="-mx-1 mt-2 flex gap-1 overflow-x-auto pb-2" aria-label="Portal">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${isActive ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:text-slate-200"}`
                }
                style={({ isActive }) => (isActive ? { boxShadow: `inset 0 -2px 0 ${accent}` } : undefined)}
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        {error && <Notice tone="error">{error}</Notice>}
        <Routes>
          <Route index element={<OverviewTab overview={overview} />} />
          <Route
            path="items"
            element={<ItemsTab session={session} overview={overview} onOpen={setOpenLine} onAuthError={onAuthError} />}
          />
          <Route path="flagged" element={<FlaggedTab onOpen={setOpenLine} onAuthError={onAuthError} session={session} />} />
          <Route path="documents" element={<DocumentsTab onAuthError={onAuthError} />} />
          {claims && (
            <Route
              path="report"
              element={
                <Suspense fallback={<p className="text-sm text-slate-400">Loading…</p>}>
                  <PortalClaimPanel token={token} getPass={getPass} />
                </Suspense>
              }
            />
          )}
          {contributor && (
            <Route
              path="scan"
              element={<ScanTab session={session} onChanged={reload} onAuthError={onAuthError} />}
            />
          )}
          <Route path="*" element={<OverviewTab overview={overview} />} />
        </Routes>
        <Footer session={session} setSession={setSession} />
      </main>
      {openLine && (
        <LineSheet
          id={openLine}
          session={session}
          onClose={() => setOpenLine(null)}
          onAuthError={onAuthError}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function Footer({ session, setSession }: { session: PortalSession; setSession: (s: PortalSession) => void }) {
  const { client } = usePortalUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { notify } = await client.setNotify(on);
      setSession({ ...session, notify });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <footer className="space-y-2 border-t border-slate-800 pt-4 text-xs text-slate-500">
      {session.email && session.mailAvailable && (
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={session.notify} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          Email me at {session.email} when it leaves, reaches key places and is delivered
        </label>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <p>
        This link is for {session.granteeName}
        {session.granteeOrg ? `, ${session.granteeOrg}` : ""} and works until {fmtDateTime(session.expiresAt)}. Anyone
        with it can open this page, so keep it to yourself.
      </p>
    </footer>
  );
}

// ---- Overview ----------------------------------------------------------------------

function MilestoneList({ overview }: { overview: PortalOverview }) {
  const { accent } = usePortalUi();
  return (
    <ol className="space-y-0">
      {overview.milestones.map((m, i) => {
        const last = i === overview.milestones.length - 1;
        const dot =
          m.state === "done" ? (
            <span className="flex h-5 w-5 items-center justify-center rounded-full text-[11px] text-white" style={{ backgroundColor: accent }}>
              ✓
            </span>
          ) : m.state === "current" ? (
            <span className="h-5 w-5 rounded-full border-4" style={{ borderColor: accent }} />
          ) : (
            <span className="h-5 w-5 rounded-full border-2 border-slate-700" />
          );
        return (
          <li key={m.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              {dot}
              {!last && <span className="w-0.5 flex-1 bg-slate-800" />}
            </div>
            <div className={`pb-4 ${m.state === "upcoming" ? "text-slate-500" : "text-slate-100"}`}>
              <p className="text-sm font-medium">
                {m.label}
                {m.detail && <span className="ml-2 text-xs font-normal text-slate-400">{m.detail}</span>}
              </p>
              {m.at && <p className="text-xs text-slate-400">{fmtDateTime(m.at)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-200">{value}</dd>
    </div>
  );
}

function PositionFact({ p }: { p: PortalShipment["lastPosition"] }) {
  if (!p) return null;
  const where =
    p.place ??
    (p.lat !== null && p.lng !== null ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : null);
  if (!where) return null;
  const map =
    p.lat !== null && p.lng !== null
      ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=13/${p.lat}/${p.lng}`
      : null;
  return (
    <Fact
      label="Last known position"
      value={
        <>
          {map ? (
            <a href={map} target="_blank" rel="noreferrer noopener" className="underline decoration-slate-600">
              {where}
            </a>
          ) : (
            where
          )}
          <span className="block text-xs text-slate-400">{fmtDateTime(p.at)}</span>
        </>
      }
    />
  );
}

function ShipmentCard({ s }: { s: PortalShipment }) {
  const n = (v: number | null, unit: string) => (v === null ? null : `${v.toLocaleString()} ${unit}`);
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium text-slate-100">
          {s.name} <span className="text-sm text-slate-400">{s.code}</span>
        </h3>
        <Chip tone={s.status === "delivered" || s.status === "closed" ? "sky" : "slate"}>{words(s.status)}</Chip>
      </div>
      <div className="mt-3">
        <ProgressBar progress={s.progress} label={`${s.code} progress`} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Fact label="Shipment" value={s.code} />
        <Fact label="Weight" value={n(s.weightKg, "kg")} />
        <Fact label="Volume" value={n(s.volumeM3, "m³")} />
        <Fact label="Distance" value={n(s.distanceKm, "km")} />
        <Fact label="Estimated arrival" value={fmtDateTime(s.eta)} />
        <Fact label="Left" value={fmtDateTime(s.departedAt)} />
        <Fact label="Arrived" value={fmtDateTime(s.arrivedAt)} />
        <Fact label="Carrier" value={s.carrier} />
        <Fact label="Vehicle" value={s.vehicle} />
        <Fact label="Seals" value={s.sealNumbers.length ? s.sealNumbers.join(", ") : null} />
        <PositionFact p={s.lastPosition} />
      </dl>
    </section>
  );
}

function OverviewTab({ overview }: { overview: PortalOverview | null }) {
  if (!overview) return <p className="text-slate-400">Loading…</p>;
  const job = overview.jobs.length === 1 ? overview.jobs[0]! : null;
  return (
    <>
      <section className={CARD}>
        <h2 className={H2}>Progress</h2>
        <div className="mt-3 space-y-3">
          <ProgressBar progress={overview.progress} label="Overall progress" />
          <StepBars progress={overview.progress} />
          {overview.progress.exceptions > 0 && (
            <Notice tone="warn">
              {overview.progress.exceptions} {overview.progress.exceptions === 1 ? "line needs" : "lines need"} attention
              (missing or damaged). See Flagged.
            </Notice>
          )}
        </div>
      </section>
      <section className={CARD}>
        <h2 className={H2}>Timeline</h2>
        <div className="mt-3">
          <MilestoneList overview={overview} />
        </div>
      </section>
      {job && (job.origin || job.destination || job.scheduledStart) && (
        <section className={CARD}>
          <dl className="grid grid-cols-2 gap-3">
            <Fact label="From" value={job.origin} />
            <Fact label="To" value={job.destination} />
            <Fact label="Scheduled" value={fmtDateTime(job.scheduledStart)} />
            <Fact label="Finished" value={fmtDateTime(job.completedAt)} />
          </dl>
        </section>
      )}
      {overview.shipments.map((s) => (
        <ShipmentCard key={s.id} s={s} />
      ))}
      {overview.updates.length > 0 && (
        <section className={CARD}>
          <h2 className={H2}>Updates</h2>
          <ul className="mt-2 divide-y divide-slate-800">
            {overview.updates.map((u, i) => (
              <li key={`${u.at}-${i}`} className="flex justify-between gap-3 py-2 text-sm">
                <span className="text-slate-200">{u.title}</span>
                <span className="whitespace-nowrap text-xs text-slate-500">{fmtDateTime(u.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ---- Items -------------------------------------------------------------------------

function useMoney() {
  const { currency, locale } = usePortalUi();
  return (cents: number) =>
    new Intl.NumberFormat(locale || undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: 0 }).format(
      cents / 100,
    );
}

function LineFlags({ line }: { line: PortalLine }) {
  return (
    <>
      {line.flags.exception && <Chip tone="red">Needs attention</Chip>}
      {line.flags.highValue && <Chip tone="amber">High value</Chip>}
      {line.flags.conditionNoted && <Chip tone="amber">Condition noted</Chip>}
      {line.flags.handling && <Chip tone="sky">Handling note</Chip>}
    </>
  );
}

function LineRow({ line, onOpen }: { line: PortalLine; onOpen: (id: string) => void }) {
  const where = [line.room, line.floor ? `Floor ${line.floor}` : null, line.crateNo ? `Crate ${line.crateNo}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button type="button" onClick={() => onOpen(line.id)} className="flex w-full items-start gap-3 py-3 text-left">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-100">{line.unitLabel ? `${line.itemName} (${line.unitLabel})` : line.itemName}</p>
          <p className="truncate text-xs text-slate-400">
            {line.code}
            {where ? ` · ${where}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <LineFlags line={line} />
            {line.photoCount > 0 && <Chip tone="slate">{line.photoCount} photo{line.photoCount === 1 ? "" : "s"}</Chip>}
          </div>
        </div>
        <StageBadge stage={line.stage} />
      </button>
    </li>
  );
}

const PAGE = 50;

function ItemsTab({
  session,
  overview,
  onOpen,
  onAuthError,
}: {
  session: PortalSession;
  overview: PortalOverview | null;
  onOpen: (id: string) => void;
  onAuthError: (err: unknown) => boolean;
}) {
  const { client } = usePortalUi();
  const [filter, setFilter] = useState<LineFilter>({});
  const [q, setQ] = useState("");
  const [page, setPage] = useState<LinePage | null>(null);
  const [more, setMore] = useState<PortalLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRooms, setShowRooms] = useState(false);

  useEffect(() => {
    const next = q.trim() || undefined;
    const t = setTimeout(() => setFilter((f) => (f.q === next ? f : { ...f, q: next })), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let live = true;
    client
      .items({ ...filter, limit: PAGE })
      .then((p) => {
        if (!live) return;
        setPage(p);
        setMore([]);
        setError(null);
      })
      .catch((err) => live && !onAuthError(err) && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [client, filter, onAuthError]);

  const loadMore = async () => {
    if (!page) return;
    try {
      const next = await client.items({ ...filter, limit: PAGE, offset: page.lines.length + more.length });
      setMore((m) => [...m, ...next.lines]);
    } catch (err) {
      if (!onAuthError(err)) setError(errorText(err));
    }
  };

  const lines = page ? [...page.lines, ...more] : [];
  const rooms = page?.facets.rooms ?? [];
  const shipments = overview && overview.shipments.length > 1 ? overview.shipments : [];
  const set = (patch: Partial<LineFilter>) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <>
      <section className={`${CARD} space-y-3`}>
        <input
          className={FIELD}
          type="search"
          placeholder={`Search by name, tag, crate or ${session.instance.locationTerm.singular.toLowerCase()}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select className={FIELD} value={filter.room ?? ""} onChange={(e) => set({ room: e.target.value || undefined })} aria-label="Room">
            <option value="">Every room</option>
            {rooms
              .filter((r) => r.room)
              .map((r) => (
                <option key={r.room!} value={r.room!}>
                  {r.room} ({r.progress.total})
                </option>
              ))}
          </select>
          <select className={FIELD} value={filter.stage ?? ""} onChange={(e) => set({ stage: e.target.value || undefined })} aria-label="Stage">
            <option value="">Every stage</option>
            {session.stages
              .filter((s) => page?.facets.stages[s.name])
              .map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label} ({page?.facets.stages[s.name]})
                </option>
              ))}
          </select>
          <select
            className={FIELD}
            value={filter.flag ?? ""}
            onChange={(e) => set({ flag: (e.target.value || undefined) as LineFilter["flag"] })}
            aria-label="Condition"
          >
            <option value="">Any condition</option>
            <option value="flagged">Flagged</option>
            <option value="high_value">High value</option>
            <option value="exception">Missing or damaged</option>
            <option value="noted">With notes</option>
          </select>
          {shipments.length > 0 && (
            <select className={FIELD} value={filter.shipmentId ?? ""} onChange={(e) => set({ shipmentId: e.target.value || undefined })} aria-label="Shipment">
              <option value="">Every shipment</option>
              {shipments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          )}
        </div>
      </section>

      {rooms.length > 1 && (
        <section className={CARD}>
          <button type="button" className="flex w-full items-center justify-between" onClick={() => setShowRooms((s) => !s)}>
            <h2 className={H2}>By room</h2>
            <span className="text-xs text-slate-400">{showRooms ? "Hide" : `Show ${rooms.length}`}</span>
          </button>
          {showRooms && (
            <ul className="mt-3 space-y-2">
              {rooms.map((r) => (
                <li key={r.room ?? "none"}>
                  <button type="button" className="w-full text-left" onClick={() => set({ room: r.room ?? undefined })} disabled={!r.room}>
                    <span className="text-sm text-slate-200">{r.room ?? "No room given"}</span>
                    <span className="ml-2 text-xs text-slate-500">{r.progress.total}</span>
                    <ProgressBar progress={r.progress} label={`${r.room ?? "No room"} progress`} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      <section className={CARD}>
        <p className="text-xs text-slate-400">{page ? `${page.total} ${page.total === 1 ? session.instance.itemTerm.singular.toLowerCase() : session.instance.itemTerm.plural.toLowerCase()}` : "Loading…"}</p>
        <ul className="divide-y divide-slate-800">
          {lines.map((l) => (
            <LineRow key={l.id} line={l} onOpen={onOpen} />
          ))}
        </ul>
        {page && lines.length < page.total && (
          <button type="button" className={`${BTN_QUIET} mt-2 w-full`} onClick={() => void loadMore()}>
            Show more
          </button>
        )}
      </section>
    </>
  );
}

// ---- One line ------------------------------------------------------------------------

function LineSheet({
  id,
  session,
  onClose,
  onAuthError,
  onChanged,
}: {
  id: string;
  session: PortalSession;
  onClose: () => void;
  onAuthError: (err: unknown) => boolean;
  onChanged: () => void;
}) {
  const { client } = usePortalUi();
  const money = useMoney();
  const [detail, setDetail] = useState<LineDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await client.line(id));
    } catch (err) {
      if (!onAuthError(err)) setError(errorText(err));
    }
  }, [client, id, onAuthError]);
  useEffect(() => {
    void load();
  }, [load]);

  const line = detail?.line;
  return (
    <Modal title={line ? line.itemName : "Loading…"} onClose={onClose} wide>
      {error && <Notice tone="error">{error}</Notice>}
      {line && detail && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StageBadge stage={line.stage} />
            <LineFlags line={line} />
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Fact label="Tag" value={line.code} />
            <Fact label="Make and model" value={[line.brand, line.model].filter(Boolean).join(" ")} />
            <Fact label="Room" value={line.room} />
            <Fact label="Floor" value={line.floor} />
            <Fact label="Department" value={line.department} />
            <Fact label="Crate" value={line.crateNo} />
            <Fact label="Shipment" value={line.shipmentCode} />
            <Fact label="Since" value={fmtDateTime(line.stageAt)} />
            {"valueCents" in line && line.valueCents != null && <Fact label="Value" value={money(line.valueCents)} />}
          </dl>
          {line.handlingNotes && <Notice tone="info">{line.handlingNotes}</Notice>}

          <section>
            <h3 className={H2}>Photos</h3>
            {detail.photos.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">No photos yet.</p>
            ) : (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {detail.photos.map((p) => (
                  <div key={p.id}>
                    <PortalImage id={p.id} alt={p.caption ?? "Photo"} className="aspect-square w-full" onClick={() => setZoom(p.id)} />
                    <p className="mt-0.5 truncate text-[11px] text-slate-500">{p.caption ?? words(p.stage ?? "photo")}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className={H2}>Condition notes</h3>
            {detail.notes.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">No notes yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {detail.notes.map((n) => (
                  <li key={n.id} className="rounded-lg bg-slate-800/60 p-2 text-sm">
                    <p className="text-slate-200">
                      {n.condition && <Chip tone={n.condition === "damaged" || n.condition === "poor" ? "red" : "slate"}>{words(n.condition)}</Chip>}{" "}
                      {n.body}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {n.mine ? "You" : n.author} · {fmtDateTime(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {session.role === "contributor" && session.contributor && (
            <ContributeForms
              lineId={line.id}
              conditions={session.contributor.conditions}
              photoStages={session.contributor.photoStages}
              onSaved={() => {
                void load();
                onChanged();
              }}
            />
          )}

          <section>
            <h3 className={H2}>History</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {detail.history.map((h, i) => (
                <li key={i} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1">
                    <StageBadge stage={h.to} />
                    <span className="text-xs text-slate-500">{h.via === "portal" ? "by crew link" : h.via === "rfid" ? "by reader" : ""}</span>
                  </span>
                  <span className="text-xs text-slate-500">{fmtDateTime(h.at)}</span>
                </li>
              ))}
              {detail.history.length === 0 && <li className="text-slate-500">Not moved yet.</li>}
            </ul>
          </section>
        </div>
      )}
      {zoom && (
        <Modal title="Photo" onClose={() => setZoom(null)} wide>
          <PortalImage id={zoom} thumb={1024} alt="Photo" className="w-full" />
        </Modal>
      )}
    </Modal>
  );
}

function ContributeForms({
  lineId,
  conditions,
  photoStages,
  onSaved,
}: {
  lineId: string;
  conditions: NoteCondition[];
  photoStages: string[];
  onSaved: () => void;
}) {
  const { client } = usePortalUi();
  const [body, setBody] = useState("");
  const [condition, setCondition] = useState<NoteCondition | "">("");
  const [photoStage, setPhotoStage] = useState(photoStages[0] ?? "condition");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState<"note" | "photo" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const saveNote = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("note");
    setMessage(null);
    try {
      await client.addNote(lineId, body, condition || null);
      setBody("");
      setCondition("");
      setMessage({ tone: "ok", text: "Note added." });
      onSaved();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy("photo");
    setMessage(null);
    try {
      await client.addPhoto(lineId, file, photoStage, caption);
      setCaption("");
      setMessage({ tone: "ok", text: "Photo added." });
      onSaved();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-slate-800 p-3">
      <h3 className={H2}>Add from the field</h3>
      <form onSubmit={saveNote} className="space-y-2">
        <div className="flex gap-2">
          <select className={`${FIELD} w-40`} value={condition} onChange={(e) => setCondition(e.target.value as NoteCondition | "")} aria-label="Condition">
            <option value="">Condition…</option>
            {conditions.map((c) => (
              <option key={c} value={c}>
                {words(c)}
              </option>
            ))}
          </select>
          <input className={FIELD} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Scratch on the left door" maxLength={2000} aria-label="Note" />
        </div>
        <AccentButton type="submit" disabled={busy !== null || !body.trim()}>
          {busy === "note" ? "Saving…" : "Add note"}
        </AccentButton>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${FIELD} w-40`} value={photoStage} onChange={(e) => setPhotoStage(e.target.value)} aria-label="Photo stage">
          {photoStages.map((s) => (
            <option key={s} value={s}>
              {words(s)}
            </option>
          ))}
        </select>
        <input className={`${FIELD} flex-1`} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption (optional)" maxLength={500} aria-label="Caption" />
        <label className={`${BTN_QUIET} cursor-pointer`}>
          {busy === "photo" ? "Uploading…" : "Take or add photo"}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            disabled={busy !== null}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </label>
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </section>
  );
}

// ---- Flagged -------------------------------------------------------------------------

function FlaggedTab({
  session,
  onOpen,
  onAuthError,
}: {
  session: PortalSession;
  onOpen: (id: string) => void;
  onAuthError: (err: unknown) => boolean;
}) {
  const { client } = usePortalUi();
  const money = useMoney();
  const [data, setData] = useState<FlaggedPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client
      .flagged()
      .then(setData)
      .catch((err) => !onAuthError(err) && setError(errorText(err)));
  }, [client, onAuthError]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="text-slate-400">Loading…</p>;
  if (!data.lines.length) return <Notice>Nothing is flagged: no high-value {session.instance.itemTerm.plural.toLowerCase()}, condition notes or exceptions.</Notice>;
  return (
    <>
      {data.highValueThreshold !== null && (
        <p className="text-xs text-slate-500">High value means worth {money(data.highValueThreshold)} or more.</p>
      )}
      <ul className="space-y-3">
        {data.lines.map((l) => (
          <li key={l.id} className={CARD}>
            <button type="button" onClick={() => onOpen(l.id)} className="w-full text-left">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-100">{l.itemName}</p>
                  <p className="truncate text-xs text-slate-400">
                    {l.code}
                    {l.room ? ` · ${l.room}` : ""}
                  </p>
                </div>
                <StageBadge stage={l.stage} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <LineFlags line={l} />
                {"valueCents" in l && l.valueCents != null && <Chip tone="slate">{money(l.valueCents)}</Chip>}
              </div>
              {l.handlingNotes && <p className="mt-2 text-sm text-slate-300">{l.handlingNotes}</p>}
            </button>
            {l.photoIds.length > 0 && (
              <div className="mt-3 grid grid-cols-4 gap-2">
                {l.photoIds.map((p) => (
                  <PortalImage key={p} id={p} alt={`Photo of ${l.itemName}`} className="aspect-square w-full rounded-lg" onClick={() => onOpen(l.id)} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- Documents -----------------------------------------------------------------------

function DocumentsTab({ onAuthError }: { onAuthError: (err: unknown) => boolean }) {
  const { client } = usePortalUi();
  const [data, setData] = useState<PortalDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client
      .documents()
      .then(setData)
      .catch((err) => !onAuthError(err) && setError(errorText(err)));
  }, [client, onAuthError]);
  const open = (id: string, name: string) =>
    openPortalFile(client, id, name).catch((err) => !onAuthError(err) && setError(errorText(err)));
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="text-slate-400">Loading…</p>;
  if (!data.shared) return <Notice>No documents are shared through this link.</Notice>;
  return (
    <>
      <section className={CARD}>
        <h2 className={H2}>Documents</h2>
        {data.documents.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing shared yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {data.documents.map((d) => {
              const name = d.filename ?? d.caption ?? `${words(d.kind)} ${fmtDate(d.createdAt)}`;
              return (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200">{name}</p>
                    <p className="text-xs text-slate-500">
                      {d.owner} · {formatBytes(d.sizeBytes)} · {fmtDate(d.createdAt)}
                    </p>
                  </div>
                  <button type="button" className={BTN_QUIET} onClick={() => void open(d.id, name)}>
                    Open
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className={CARD}>
        <h2 className={H2}>Signed receipts</h2>
        {data.receipts.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing signed yet.</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {data.receipts.map((r) => (
              <li key={r.id} className="rounded-lg bg-slate-800/50 p-3 text-sm">
                <p className="font-medium text-slate-100">
                  {r.signerName}
                  {r.signerRole ? <span className="font-normal text-slate-400">, {r.signerRole}</span> : null}
                </p>
                <p className="text-xs text-slate-500">
                  {r.owner} · {fmtDateTime(r.signedAt)}
                </p>
                <p className="mt-1 text-slate-300">“{r.statement}”</p>
                {r.imageId && (
                  <div className="mt-2 w-48 rounded bg-white p-1">
                    <PortalImage id={r.imageId} thumb={0} alt={`Signature of ${r.signerName}`} className="h-16 w-full object-contain" />
                  </div>
                )}
                <p className="mt-1 break-all font-mono text-[11px] text-slate-500">Fingerprint {r.contentHash.slice(0, 16)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ---- Scanning (crew links) ---------------------------------------------------------------

type FeedEntry = { key: string; tone: "ok" | "already" | "warn" | "error"; code: string; text: string };

function feedFrom(result: ScanResult): FeedEntry[] {
  const out: FeedEntry[] = [];
  const k = () => `${Date.now()}-${Math.random()}`;
  for (const l of result.advanced) out.push({ key: k(), tone: "ok", code: l.scanned ?? l.code, text: `${l.itemName}: now ${words(result.stage)}` });
  for (const l of result.alreadyAt) out.push({ key: k(), tone: "already", code: l.scanned ?? l.code, text: `${l.itemName}: already ${words(l.stage)}` });
  for (const l of result.wrongShipment) {
    out.push({ key: k(), tone: "warn", code: l.scanned ?? l.code, text: `${l.itemName}: belongs on ${l.shipmentCode ?? "another shipment"}` });
  }
  for (const l of result.blocked) out.push({ key: k(), tone: "error", code: l.scanned ?? l.code, text: `${l.itemName}: ${l.reason}` });
  for (const c of result.notInScope) out.push({ key: k(), tone: "error", code: c, text: "Not part of this job. Set it aside." });
  for (const c of result.unknown) out.push({ key: k(), tone: "error", code: c, text: "Not recognised. Check the label." });
  return out;
}

const TONE = {
  ok: "border-emerald-700 bg-emerald-950/40 text-emerald-200",
  already: "border-slate-700 bg-slate-800/50 text-slate-300",
  warn: "border-amber-700 bg-amber-950/40 text-amber-200",
  error: "border-red-800 bg-red-950/40 text-red-200",
};

function ScanTab({
  session,
  onChanged,
  onAuthError,
}: {
  session: PortalSession;
  onChanged: () => void;
  onAuthError: (err: unknown) => boolean;
}) {
  const { client } = usePortalUi();
  const c = session.contributor!;
  const [stage, setStage] = useState(c.stages[0]?.name ?? "");
  const [shipmentId, setShipmentId] = useState<string>("");
  const [manual, setManual] = useState("");
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [camera, setCamera] = useState(false);
  const [cameraKey, setCameraKey] = useState(0);
  const [signing, setSigning] = useState(false);
  const [receipt, setReceipt] = useState<HandoffReceipt | null>(null);
  const queue = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCamera = useRef<{ code: string; at: number } | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const shipmentRef = useRef(shipmentId);
  shipmentRef.current = shipmentId;

  const flush = useCallback(async () => {
    timer.current = null;
    const codes = queue.current.splice(0);
    if (!codes.length) return;
    try {
      const result = await client.scan(codes, stageRef.current, shipmentRef.current || null);
      const entries = feedFrom(result);
      setFeed((f) => [...entries, ...f].slice(0, 100));
      const worst = entries.some((e) => e.tone === "error" || e.tone === "warn") ? "error" : result.advanced.length ? "ok" : "already";
      play(worst);
      if (worst === "error") navigator.vibrate?.([80, 60, 80]);
      if (result.advanced.length) onChanged();
    } catch (err) {
      if (onAuthError(err)) return;
      play("error");
      setFeed((f) => [{ key: `${Date.now()}`, tone: "error" as const, code: codes.join(", "), text: errorText(err) }, ...f]);
    }
  }, [client, onAuthError, onChanged]);

  const enqueue = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      queue.current.push(trimmed);
      // Codes that arrive together (a burst from a reader) go in one request.
      if (!timer.current) timer.current = setTimeout(() => void flush(), 150);
    },
    [flush],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // A handheld reader acting as a keyboard works anywhere on this tab.
  useScannerListener(enqueue, !camera && !signing);

  const onCamera = useCallback(
    (code: string) => {
      const now = Date.now();
      // The camera sees the same label several times a second.
      if (lastCamera.current && lastCamera.current.code === code && now - lastCamera.current.at < 2500) {
        setCameraKey((k) => k + 1);
        return;
      }
      lastCamera.current = { code, at: now };
      enqueue(code);
      // Remount to keep scanning: the scanner stops after each read.
      setCameraKey((k) => k + 1);
    },
    [enqueue],
  );

  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    primeAudio();
    enqueue(manual);
    setManual("");
  };

  return (
    <>
      <section className={`${CARD} space-y-3`}>
        <div>
          <p className="mb-1 text-xs text-slate-400">Record scans as</p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Stage">
            {c.stages.map((s) => (
              <button
                key={s.name}
                type="button"
                role="radio"
                aria-checked={stage === s.name}
                onClick={() => setStage(s.name)}
                className={`rounded-full border px-3 py-1.5 text-sm ${stage === s.name ? "border-transparent text-white" : "border-slate-700 text-slate-300"}`}
                style={stage === s.name ? { backgroundColor: s.color ?? "#0284c7" } : undefined}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {c.shipments.length > 0 && (
          <select className={FIELD} value={shipmentId} onChange={(e) => setShipmentId(e.target.value)} aria-label="Shipment">
            <option value="">No particular shipment</option>
            {c.shipments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        )}
        <form onSubmit={submitManual} className="flex gap-2">
          <input
            className={FIELD}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Type a tag or code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Code"
          />
          <AccentButton type="submit" disabled={!manual.trim()}>
            Add
          </AccentButton>
        </form>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BTN_QUIET}
            onClick={() => {
              primeAudio();
              setCamera(true);
            }}
          >
            Scan with camera
          </button>
          <button type="button" className={BTN_QUIET} onClick={() => setSigning(true)}>
            Sign handoff
          </button>
        </div>
      </section>

      {receipt && (
        <Notice tone="ok">
          Signed by {receipt.signerName} for {receipt.owner}, {receipt.lines} lines. Fingerprint {receipt.contentHash.slice(0, 16)}.
        </Notice>
      )}

      <section className={CARD}>
        <h2 className={H2}>Scanned</h2>
        {feed.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Scan a label, or type its code. Each result shows here.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {feed.map((e) => (
              <li key={e.key} className={`rounded-lg border px-3 py-2 text-sm ${TONE[e.tone]}`}>
                <span className="font-mono text-xs opacity-80">{e.code}</span>
                <span className="block">{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {camera && (
        <Suspense fallback={null}>
          <CameraScanner key={cameraKey} onScan={onCamera} onClose={() => setCamera(false)} />
        </Suspense>
      )}
      {signing && (
        <HandoffDialog
          session={session}
          shipmentId={shipmentId || null}
          onClose={() => setSigning(false)}
          onSigned={(r) => {
            setReceipt(r);
            setSigning(false);
          }}
        />
      )}
    </>
  );
}

function HandoffDialog({
  session,
  shipmentId,
  onClose,
  onSigned,
}: {
  session: PortalSession;
  shipmentId: string | null;
  onClose: () => void;
  onSigned: (r: HandoffReceipt) => void;
}) {
  const { client } = usePortalUi();
  const [name, setName] = useState(session.granteeName);
  const [role, setRole] = useState(session.granteeOrg ?? "");
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shipment = session.contributor?.shipments.find((s) => s.id === shipmentId);
  const what = shipment ? `${shipment.name} (${shipment.code})` : session.scope ? `${session.scope.name} (${session.scope.code})` : "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      onSigned(await client.handoff({ signerName: name, signerRole: role || null, image, shipmentId }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Sign handoff" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-300">
          For <span className="font-medium">{what}</span>, with every line at the stage it has reached now.
        </p>
        <p className="rounded-lg bg-slate-800/60 p-3 text-sm text-slate-200">“{session.contributor?.handoffStatement}”</p>
        <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required maxLength={200} aria-label="Name" />
        <input className={FIELD} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Company or role" maxLength={200} aria-label="Role" />
        <div className="rounded-lg bg-white">
          <SignaturePad onSigned={setImage} />
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_QUIET} onClick={onClose}>
            Cancel
          </button>
          <AccentButton type="submit" disabled={busy || !image || !name.trim()}>
            {busy ? "Signing…" : "Sign"}
          </AccentButton>
        </div>
      </form>
    </Modal>
  );
}

export type { PortalClient };
