import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import { useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { opsApi } from "./api";
import type { LocationRole, OpsMeta, OpsSettings, Profile, ProfileInput, RuleId } from "./types";
import { BTN, BTN_QUIET, CARD, FIELD, H2, NUM, Notice, SELECT, TABLE, TD, TH, errorText, kg, m3, metres } from "./ui";

/**
 * Thresholds for every rule and analysis, and the per-place facts they use.
 * Anyone can read them; only an administrator can change them.
 */
export function SetupPanel({ meta, onSaved }: { meta: OpsMeta; onSaved: () => void }) {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  return (
    <div className="space-y-5">
      {!admin && <Notice tone="info">Only an administrator can change these.</Notice>}
      <ThresholdsForm meta={meta} admin={admin} onSaved={onSaved} />
      <ProfilesSection roles={meta.roles} admin={admin} />
    </div>
  );
}

// --- Thresholds ------------------------------------------------------------------

type NumField = { label: string; get: (s: OpsSettings) => number; set: (s: OpsSettings, v: number) => void; step?: number; hint?: string };

const RULE_FIELDS: Partial<Record<RuleId, NumField[]>> = {
  loaded_not_delivered: [
    {
      label: "Grace after arrival (minutes)",
      get: (s) => s.rules.loaded_not_delivered.graceMinutes,
      set: (s, v) => (s.rules.loaded_not_delivered.graceMinutes = v),
    },
  ],
  delivered_not_placed: [
    { label: "Hours at delivered", get: (s) => s.rules.delivered_not_placed.hours, set: (s, v) => (s.rules.delivered_not_placed.hours = v) },
  ],
  duplicate_record: [
    {
      label: "Largest group to report",
      get: (s) => s.rules.duplicate_record.maxGroup,
      set: (s, v) => (s.rules.duplicate_record.maxGroup = v),
      hint: "Bigger groups are a set of identical things.",
    },
  ],
  impossible_travel: [
    { label: "Fastest believable (km/h)", get: (s) => s.rules.impossible_travel.maxSpeedKmh, set: (s, v) => (s.rules.impossible_travel.maxSpeedKmh = v) },
    { label: "Ignore under (m)", get: (s) => s.rules.impossible_travel.minDistanceM, set: (s, v) => (s.rules.impossible_travel.minDistanceM = v) },
    { label: "Look back (hours)", get: (s) => s.rules.impossible_travel.lookbackHours, set: (s, v) => (s.rules.impossible_travel.lookbackHours = v) },
  ],
  zone_mismatch: [{ label: "Hours in the other zone", get: (s) => s.rules.zone_mismatch.hours, set: (s, v) => (s.rules.zone_mismatch.hours = v) }],
  not_seen: [{ label: "Days without a read", get: (s) => s.rules.not_seen.days, set: (s, v) => (s.rules.not_seen.days = v) }],
};

const OTHER_FIELDS: { title: string; fields: NumField[] }[] = [
  {
    title: "Jobs",
    fields: [
      {
        label: "Keep checking completed jobs for (days)",
        get: (s) => s.jobLookbackDays,
        set: (s, v) => (s.jobLookbackDays = v),
      },
    ],
  },
  {
    title: "Storage",
    fields: [
      { label: "Movement window (days)", get: (s) => s.storage.windowDays, set: (s, v) => (s.storage.windowDays = v) },
      { label: "Long stored after (days)", get: (s) => s.storage.longStoredDays, set: (s, v) => (s.storage.longStoredDays = v) },
      { label: "Class A share of movement", get: (s) => s.storage.abcA, set: (s, v) => (s.storage.abcA = v), step: 0.01 },
      { label: "Class A and B share", get: (s) => s.storage.abcB, set: (s, v) => (s.storage.abcB = v), step: 0.01 },
    ],
  },
  {
    title: "Slotting",
    fields: [
      { label: "Smallest worthwhile gain (m)", get: (s) => s.slotting.minGainM, set: (s, v) => (s.slotting.minGainM = v) },
      { label: "Most suggestions", get: (s) => s.slotting.maxSuggestions, set: (s, v) => (s.slotting.maxSuggestions = v) },
    ],
  },
  {
    title: "Load planning",
    fields: [
      { label: "Default weight (kg)", get: (s) => s.load.defaultWeightKg, set: (s, v) => (s.load.defaultWeightKg = v), step: 0.1 },
      { label: "Default volume (m³)", get: (s) => s.load.defaultVolumeM3, set: (s, v) => (s.load.defaultVolumeM3 = v), step: 0.001 },
      {
        label: "Usable share of volume",
        get: (s) => s.load.fillFactor,
        set: (s, v) => (s.load.fillFactor = v),
        step: 0.01,
        hint: "Boxes never stack without gaps.",
      },
    ],
  },
];

function NumberInput({ field, draft, disabled, onChange }: { field: NumField; draft: OpsSettings; disabled: boolean; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{field.label}</span>
      <input
        type="number"
        step={field.step ?? 1}
        min={0}
        value={field.get(draft)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${FIELD} mt-1`}
      />
      {field.hint && <span className="mt-0.5 block text-xs text-slate-500">{field.hint}</span>}
    </label>
  );
}

function ThresholdsForm({ meta, admin, onSaved }: { meta: OpsMeta; admin: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState<OpsSettings>(() => structuredClone(meta.settings));
  const [categories, setCategories] = useState(() =>
    Object.entries(meta.settings.load.categoryDefaults).map(([name, v]) => ({ name, weightKg: v.weightKg ?? null, volumeM3: v.volumeM3 ?? null })),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const update = (fn: (s: OpsSettings) => void) =>
    setDraft((d) => {
      const next = structuredClone(d);
      fn(next);
      return next;
    });

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const categoryDefaults: OpsSettings["load"]["categoryDefaults"] = {};
      for (const c of categories) {
        if (!c.name.trim()) continue;
        categoryDefaults[c.name.trim()] = { weightKg: c.weightKg || null, volumeM3: c.volumeM3 || null };
      }
      const saved = await opsApi.saveSettings({ ...draft, load: { ...draft.load, categoryDefaults } });
      setDraft(saved);
      setMessage({ tone: "ok", text: "Saved. The next run uses the new thresholds." });
      onSaved();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "The thresholds could not be saved.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${CARD} space-y-4`}>
      <h2 className={H2}>Rules and thresholds</h2>
      <ul className="space-y-3">
        {meta.rules.map((r) => (
          <li key={r.rule} className="space-y-2 rounded-lg border border-slate-800 p-3">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.rules[r.rule].enabled}
                disabled={!admin}
                onChange={(e) => update((s) => (s.rules[r.rule].enabled = e.target.checked))}
              />
              <span>
                <span className="font-medium text-slate-100">{r.title}</span>
                {r.sticky && <span className="ml-2 text-xs text-slate-500">stays open until resolved</span>}
                <span className="block text-sm text-slate-400">{r.description}</span>
              </span>
            </label>
            {RULE_FIELDS[r.rule] && (
              <div className="grid gap-2 pl-7 sm:grid-cols-3">
                {RULE_FIELDS[r.rule]!.map((f) => (
                  <NumberInput key={f.label} field={f} draft={draft} disabled={!admin} onChange={(v) => update((s) => f.set(s, v))} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {OTHER_FIELDS.map((g) => (
        <div key={g.title} className="space-y-2">
          <h3 className="text-sm font-medium text-slate-200">{g.title}</h3>
          <div className="grid gap-2 sm:grid-cols-4">
            {g.fields.map((f) => (
              <NumberInput key={f.label} field={f} draft={draft} disabled={!admin} onChange={(v) => update((s) => f.set(s, v))} />
            ))}
          </div>
        </div>
      ))}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-slate-200">Sizes by category</h3>
        <p className="text-xs text-slate-500">
          Used when a record has no weightKg, volumeM3 or lengthCm × widthCm × heightCm of its own.
        </p>
        {categories.map((c, i) => (
          <div key={i} className="grid grid-cols-[1fr_7rem_7rem_auto] items-center gap-2">
            <input
              value={c.name}
              disabled={!admin}
              onChange={(e) => setCategories((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              placeholder="Category"
              aria-label="Category"
              className={FIELD}
            />
            <input
              type="number"
              step={0.1}
              min={0}
              value={c.weightKg ?? ""}
              disabled={!admin}
              onChange={(e) => setCategories((cs) => cs.map((x, j) => (j === i ? { ...x, weightKg: e.target.value ? Number(e.target.value) : null } : x)))}
              placeholder="kg"
              aria-label="Weight in kg"
              className={FIELD}
            />
            <input
              type="number"
              step={0.001}
              min={0}
              value={c.volumeM3 ?? ""}
              disabled={!admin}
              onChange={(e) => setCategories((cs) => cs.map((x, j) => (j === i ? { ...x, volumeM3: e.target.value ? Number(e.target.value) : null } : x)))}
              placeholder="m³"
              aria-label="Volume in cubic metres"
              className={FIELD}
            />
            {admin && (
              <button onClick={() => setCategories((cs) => cs.filter((_, j) => j !== i))} className={BTN_QUIET} aria-label="Remove">
                ✕
              </button>
            )}
          </div>
        ))}
        {admin && (
          <button onClick={() => setCategories((cs) => [...cs, { name: "", weightKg: null, volumeM3: null }])} className={BTN_QUIET}>
            Add a category
          </button>
        )}
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {admin && (
        <button onClick={save} disabled={busy} className={BTN}>
          {busy ? "Saving…" : "Save thresholds"}
        </button>
      )}
    </section>
  );
}

// --- Location profiles ---------------------------------------------------------------

const ROLE_LABEL: Record<LocationRole, string> = {
  dock: "Dock",
  pick: "Pick face",
  storage: "Storage",
  staging: "Staging",
  vehicle: "Vehicle",
};

const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

function ProfilesSection({ roles, admin }: { roles: LocationRole[]; admin: boolean }) {
  const terms = useTerms();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    opsApi
      .profiles()
      .then(setProfiles)
      .catch((err) => setError(errorText(err, "Profiles could not be loaded.")));
  useEffect(() => {
    void load();
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);

  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const pathOf = (id: string) => {
    const l = locations.find((x) => x.id === id);
    return l ? label(l) : (profiles?.find((p) => p.locationId === id)?.locationName ?? id);
  };
  const options = useMemo(
    () => locations.map((l) => ({ id: l.id, label: label(l) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [locations, label],
  );

  return (
    <section className={`${CARD} space-y-3`}>
      <div>
        <h2 className={H2}>{terms.location.singular} facts</h2>
        <p className="mt-1 text-sm text-slate-400">
          Distance to the dock for slotting (a {terms.location.singular.toLowerCase()} inside another takes its distance unless it has
          its own), coordinates of a site so readings far apart can be caught, and what a vehicle can carry for load planning.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {admin && (
        <div className="flex flex-wrap items-center gap-2">
          <select value="" onChange={(e) => e.target.value && setEditing(e.target.value)} aria-label={`Add facts to a ${terms.location.singular.toLowerCase()}`} className={SELECT}>
            <option value="">Add facts to a {terms.location.singular.toLowerCase()}…</option>
            {options
              .filter((o) => !profiles?.some((p) => p.locationId === o.id))
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
          </select>
        </div>
      )}
      {editing && (
        <ProfileEditor
          key={editing}
          locationId={editing}
          path={pathOf(editing)}
          profile={profiles?.find((p) => p.locationId === editing) ?? null}
          roles={roles}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {profiles && profiles.length === 0 && <p className="text-sm text-slate-500">None yet.</p>}
      {profiles && profiles.length > 0 && (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>{terms.location.singular}</th>
                <th className={TH}>Role</th>
                <th className={`${TH} text-right`}>To dock</th>
                <th className={TH}>Coordinates</th>
                <th className={TH}>Carries</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.locationId} className="border-t border-slate-800">
                  <td className={TD}>{pathOf(p.locationId)}</td>
                  <td className={TD}>{p.role ? ROLE_LABEL[p.role] : ""}</td>
                  <td className={NUM}>{p.distanceToDockM === null ? "" : metres(p.distanceToDockM)}</td>
                  <td className={`${TD} tabular-nums`}>{p.lat !== null && p.lng !== null ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : ""}</td>
                  <td className={TD}>
                    {[
                      p.maxKg !== null ? kg(p.maxKg) : null,
                      p.maxM3 !== null ? m3(p.maxM3) : null,
                      p.interiorLengthM && p.interiorWidthM && p.interiorHeightM
                        ? `${p.interiorLengthM} × ${p.interiorWidthM} × ${p.interiorHeightM} m`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {admin && (
                      <button onClick={() => setEditing(p.locationId)} className="text-sm text-sky-400 hover:underline">
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const FIELDS: { key: keyof ProfileInput; label: string; step: number }[] = [
  { key: "distanceToDockM", label: "Distance to the dock (m)", step: 1 },
  { key: "lat", label: "Latitude", step: 0.0001 },
  { key: "lng", label: "Longitude", step: 0.0001 },
  { key: "maxKg", label: "Carries at most (kg)", step: 1 },
  { key: "maxM3", label: "Cargo volume (m³)", step: 0.1 },
  { key: "interiorLengthM", label: "Interior length (m)", step: 0.01 },
  { key: "interiorWidthM", label: "Interior width (m)", step: 0.01 },
  { key: "interiorHeightM", label: "Interior height (m)", step: 0.01 },
];

function ProfileEditor({
  locationId,
  path,
  profile,
  roles,
  onDone,
}: {
  locationId: string;
  path: string;
  profile: Profile | null;
  roles: LocationRole[];
  onDone: () => void;
}) {
  const [role, setRole] = useState<LocationRole | "">(profile?.role ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, profile?.[f.key] == null ? "" : String(profile[f.key])])),
  );
  const [notes, setNotes] = useState(profile?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: ProfileInput = { role: role || null, notes: notes.trim() || null };
      for (const f of FIELDS) (input as Record<string, unknown>)[f.key] = numOrNull(values[f.key] ?? "");
      await opsApi.saveProfile(locationId, input);
      onDone();
    } catch (err) {
      setError(errorText(err, "The facts could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await opsApi.deleteProfile(locationId);
      onDone();
    } catch (err) {
      setError(errorText(err, "The facts could not be removed."));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-sky-900 bg-slate-950/40 p-3">
      <p className="font-medium text-slate-100">{path}</p>
      <div className="grid gap-2 sm:grid-cols-4">
        <Labeled label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as LocationRole | "")} className={`${SELECT} w-full`}>
            <option value="">Not set</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </Labeled>
        {FIELDS.map((f) => (
          <Labeled key={f.key} label={f.label}>
            <input
              type="number"
              step={f.step}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className={FIELD}
            />
          </Labeled>
        ))}
      </div>
      <Labeled label="Notes">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className={FIELD} />
      </Labeled>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button onClick={save} disabled={busy} className={BTN}>
          Save
        </button>
        <button onClick={onDone} disabled={busy} className={BTN_QUIET}>
          Cancel
        </button>
        {profile && (
          <button onClick={remove} disabled={busy} className={`${BTN_QUIET} ml-auto`}>
            Remove these facts
          </button>
        )}
      </div>
    </div>
  );
}
