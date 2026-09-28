import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";
import { Modal } from "../media-ai-core";
import { documentsApi } from "./api";
import type { Evaluation, Packet, PacketConditions, PacketOptions, Rule, RuleOp, TemplateSummary } from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  DocumentsNav,
  FIELD,
  JobPicker,
  LABEL,
  Notice,
  SELECT,
  errorText,
  useIsAdmin,
} from "./ui";

/**
 * Packets: which templates a job needs, and the conditions that decide which
 * jobs. A packet attaches itself to a job when the job is created or changes
 * to match, so an "IT relocation" job gets the IT relocation paperwork.
 */

const OP_LABEL: Record<RuleOp, string> = {
  equals: "is",
  not_equals: "is not",
  in: "is one of",
  not_in: "is none of",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  exists: "is set",
  not_exists: "is empty",
  gt: "is after / more than",
  gte: "is on or after / at least",
  lt: "is before / less than",
  lte: "is on or before / at most",
};

type Draft = {
  id: string | null;
  name: string;
  description: string;
  templateIds: string[];
  conditions: PacketConditions;
  autoAttach: boolean;
  active: boolean;
};

const blank: Draft = { id: null, name: "", description: "", templateIds: [], conditions: {}, autoAttach: true, active: true };

export function PacketsPage() {
  const admin = useIsAdmin();
  const [packets, setPackets] = useState<Packet[] | null>(null);
  const [options, setOptions] = useState<PacketOptions | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  const load = useCallback(() => {
    documentsApi
      .packets()
      .then(setPackets)
      .catch((err) => setMessage({ tone: "error", text: errorText(err, "Packets could not be loaded.") }));
  }, []);

  useEffect(() => {
    load();
    documentsApi.packetOptions().then(setOptions).catch(() => undefined);
    documentsApi.templates(true).then(setTemplates).catch(() => undefined);
  }, [load]);

  const apply = async (p: Packet) => {
    setMessage(null);
    try {
      const r = await documentsApi.applyPacket(p.id);
      setMessage({ tone: "ok", text: `Checked ${r.checked} open job${r.checked === 1 ? "" : "s"}; attached to ${r.attached}.` });
      load();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };

  if (!admin) return <Notice tone="warn">Only an administrator can manage packets.</Notice>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Document packets</h1>
        <button className={BTN} onClick={() => setEditing({ ...blank })}>
          New packet
        </button>
      </div>
      <DocumentsNav />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {packets && packets.length === 0 && (
        <Notice>No packets yet. A packet bundles templates and says which jobs get them, for example every job of type IT relocation.</Notice>
      )}
      <ul className="space-y-3">
        {packets?.map((p) => (
          <li key={p.id} className={`${CARD} space-y-2`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`font-medium ${p.active ? "text-slate-100" : "text-slate-500 line-through"}`}>{p.name}</span>
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
                {p.autoAttach ? "attaches itself" : "added by hand only"}
              </span>
              <span className="text-xs text-slate-500">on {p.jobCount} job{p.jobCount === 1 ? "" : "s"}</span>
              <span className="ml-auto flex gap-2">
                <button className={BTN_QUIET} onClick={() => void apply(p)} disabled={!p.active}>
                  Apply to open jobs
                </button>
                <button
                  className={BTN_QUIET}
                  onClick={() =>
                    setEditing({
                      id: p.id,
                      name: p.name,
                      description: p.description ?? "",
                      templateIds: p.templates.map((t) => t.id),
                      conditions: p.conditions,
                      autoAttach: p.autoAttach,
                      active: p.active,
                    })
                  }
                >
                  Edit
                </button>
              </span>
            </div>
            <p className="text-sm text-slate-400">{summarize(p.conditions, options)}</p>
            <ol className="list-inside list-decimal text-sm text-slate-300">
              {p.templates.map((t) => (
                <li key={t.id}>
                  {t.name}
                  {t.publishedVersion === null && <span className="text-amber-300"> (not published yet)</span>}
                  {!t.active && <span className="text-slate-500"> (switched off)</span>}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
      {editing && options && (
        <PacketEditor
          draft={editing}
          options={options}
          templates={templates}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setMessage({ tone: "ok", text });
            load();
          }}
        />
      )}
    </div>
  );
}

function summarize(c: PacketConditions, options: PacketOptions | null): string {
  const parts: string[] = [];
  const names = (ids: string[] | undefined, list: { id: string; name: string }[]) =>
    (ids ?? []).map((id) => list.find((x) => x.id === id)?.name ?? "a deleted one").join(" or ");
  if (c.jobTypeIds?.length) parts.push(`job type is ${names(c.jobTypeIds, options?.jobTypes ?? [])}`);
  if (c.projectIds?.length) parts.push(`project is ${names(c.projectIds, options?.projects ?? [])}`);
  if (c.phaseIds?.length) parts.push(`phase is ${names(c.phaseIds, options?.projects.flatMap((p) => p.phases) ?? [])}`);
  if (c.siteLocationIds?.length) parts.push(`at ${c.siteLocationIds.length} site${c.siteLocationIds.length === 1 ? "" : "s"}`);
  if (c.rules?.length) parts.push(`${c.rules.length} rule${c.rules.length === 1 ? "" : "s"} (${c.ruleMatch ?? "all"})`);
  return parts.length ? `Applies when ${parts.join(", and ")}.` : "Applies to every job.";
}

function PacketEditor({
  draft,
  options,
  templates,
  onClose,
  onSaved,
}: {
  draft: Draft;
  options: PacketOptions;
  templates: TemplateSummary[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const terms = useTerms();
  const [d, setD] = useState<Draft>(draft);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testJob, setTestJob] = useState("");
  const [test, setTest] = useState<Evaluation | null>(null);
  const c = d.conditions;
  const setC = (patch: Partial<PacketConditions>) => setD((cur) => ({ ...cur, conditions: { ...cur.conditions, ...patch } }));

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const locationOptions = useMemo(
    () => locations.map((l) => ({ id: l.id, label: label(l) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [locations, label],
  );

  const toggle = (key: "jobTypeIds" | "projectIds" | "phaseIds" | "siteLocationIds", id: string, on: boolean) => {
    const list = c[key] ?? [];
    setC({ [key]: on ? [...list, id] : list.filter((x) => x !== id) });
  };

  const moveTemplate = (i: number, delta: number) =>
    setD((cur) => {
      const ids = [...cur.templateIds];
      const j = i + delta;
      if (j < 0 || j >= ids.length) return cur;
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      return { ...cur, templateIds: ids };
    });

  const clean = (): PacketConditions => {
    const out: PacketConditions = {};
    if (c.jobTypeIds?.length) out.jobTypeIds = c.jobTypeIds;
    if (c.projectIds?.length) out.projectIds = c.projectIds;
    if (c.phaseIds?.length) out.phaseIds = c.phaseIds;
    if (c.siteLocationIds?.length) {
      out.siteLocationIds = c.siteLocationIds;
      out.siteSide = c.siteSide ?? "either";
    }
    const rules = (c.rules ?? []).filter((r) => r.field.trim() && r.field !== "metadata.");
    if (rules.length) {
      out.rules = rules;
      out.ruleMatch = c.ruleMatch ?? "all";
    }
    return out;
  };

  const save = async () => {
    if (!d.name.trim()) return setError("Give the packet a name.");
    if (d.autoAttach && d.active && Object.keys(clean()).length === 0) {
      if (!window.confirm("With no conditions this packet attaches itself to every job. Save it anyway?")) return;
    }
    setBusy(true);
    setError(null);
    const input = {
      name: d.name.trim(),
      description: d.description.trim() || null,
      templateIds: d.templateIds,
      conditions: clean(),
      autoAttach: d.autoAttach,
      active: d.active,
    };
    try {
      if (d.id) await documentsApi.updatePacket(d.id, input);
      else await documentsApi.createPacket(input);
      onSaved(`Saved ${input.name}. It attaches to jobs as they are created or change; use Apply to open jobs for the ones already running.`);
    } catch (err) {
      setError(errorText(err, "The packet could not be saved."));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!d.id || !window.confirm(`Delete "${d.name}"? Documents already started keep their content.`)) return;
    try {
      await documentsApi.deletePacket(d.id);
      onSaved(`Deleted ${d.name}.`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const runTest = async () => {
    if (!testJob) return;
    try {
      setTest(await documentsApi.testConditions(clean(), testJob));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const rules = c.rules ?? [];
  const setRule = (i: number, rule: Rule) => setC({ rules: rules.map((r, j) => (j === i ? rule : r)) });

  return (
    <Modal title={d.id ? `Edit ${draft.name}` : "New packet"} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className={LABEL}>Name</span>
            <input className={`${FIELD} mt-1`} value={d.name} maxLength={200} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </label>
          <label>
            <span className={LABEL}>Description</span>
            <input className={`${FIELD} mt-1`} value={d.description} maxLength={2000} onChange={(e) => setD({ ...d, description: e.target.value })} />
          </label>
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-slate-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-sky-500" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />
            In use
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-sky-500" checked={d.autoAttach} onChange={(e) => setD({ ...d, autoAttach: e.target.checked })} />
            Attach itself to matching jobs
          </label>
        </div>

        <fieldset className="space-y-2">
          <legend className={LABEL}>Templates, in order</legend>
          <ol className="space-y-1">
            {d.templateIds.map((id, i) => {
              const t = templates.find((x) => x.id === id);
              return (
                <li key={id} className="flex items-center gap-2 text-sm text-slate-200">
                  <span className="flex-1">
                    {i + 1}. {t?.name ?? "A deleted template"}
                    {t && t.publishedVersion === null && <span className="text-amber-300"> (not published yet)</span>}
                  </span>
                  <button className="text-slate-400 hover:text-slate-100" aria-label="Move up" onClick={() => moveTemplate(i, -1)}>
                    ↑
                  </button>
                  <button className="text-slate-400 hover:text-slate-100" aria-label="Move down" onClick={() => moveTemplate(i, 1)}>
                    ↓
                  </button>
                  <button
                    className="text-slate-400 hover:text-red-300"
                    aria-label="Remove"
                    onClick={() => setD({ ...d, templateIds: d.templateIds.filter((x) => x !== id) })}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
          <select
            className={`${SELECT} w-full`}
            value=""
            aria-label="Add a template"
            onChange={(e) => e.target.value && setD({ ...d, templateIds: [...d.templateIds, e.target.value] })}
          >
            <option value="">Add a template…</option>
            {templates
              .filter((t) => !d.templateIds.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-slate-800 p-3">
          <legend className="px-1 text-sm font-medium text-slate-200">Applies to jobs where</legend>
          <p className="text-xs text-slate-500">Every part you fill in must hold; within a list, any one entry will do. Leave it all empty for every job.</p>
          <CheckList
            title="Job type is one of"
            items={options.jobTypes.map((t) => ({ id: t.id, label: t.active ? t.name : `${t.name} (switched off)` }))}
            selected={c.jobTypeIds ?? []}
            onToggle={(id, on) => toggle("jobTypeIds", id, on)}
            empty="No job types yet."
          />
          <CheckList
            title="Project is one of"
            items={options.projects.map((p) => ({ id: p.id, label: `${p.code} ${p.name}` }))}
            selected={c.projectIds ?? []}
            onToggle={(id, on) => toggle("projectIds", id, on)}
            empty="No projects yet."
          />
          {options.projects.some((p) => p.phases.length) && (
            <CheckList
              title="Phase is one of"
              items={options.projects.flatMap((p) => p.phases.map((ph) => ({ id: ph.id, label: `${p.code}: ${ph.name}` })))}
              selected={c.phaseIds ?? []}
              onToggle={(id, on) => toggle("phaseIds", id, on)}
            />
          )}
          <div className="space-y-1">
            <span className={LABEL}>Site: the job's {terms.location.singular.toLowerCase()} is in one of</span>
            <div className="flex flex-wrap gap-1">
              {(c.siteLocationIds ?? []).map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-200">
                  {locationOptions.find((l) => l.id === id)?.label ?? "A deleted one"}
                  <button aria-label="Remove" onClick={() => toggle("siteLocationIds", id, false)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                className={`${SELECT} flex-1`}
                value=""
                aria-label={`Add a ${terms.location.singular.toLowerCase()}`}
                onChange={(e) => e.target.value && toggle("siteLocationIds", e.target.value, true)}
              >
                <option value="">Add a {terms.location.singular.toLowerCase()}…</option>
                {locationOptions
                  .filter((l) => !(c.siteLocationIds ?? []).includes(l.id))
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
              </select>
              <select
                className={SELECT}
                value={c.siteSide ?? "either"}
                aria-label="Which end of the job"
                onChange={(e) => setC({ siteSide: e.target.value as PacketConditions["siteSide"] })}
              >
                <option value="either">origin or destination</option>
                <option value="origin">origin only</option>
                <option value="destination">destination only</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className={LABEL}>Rules on the job's details</span>
              {rules.length > 1 && (
                <select
                  className={`${SELECT} py-1 text-xs`}
                  value={c.ruleMatch ?? "all"}
                  aria-label="How rules combine"
                  onChange={(e) => setC({ ruleMatch: e.target.value as "all" | "any" })}
                >
                  <option value="all">all must hold</option>
                  <option value="any">any one will do</option>
                </select>
              )}
            </div>
            {rules.map((r, i) => (
              <RuleRow
                key={i}
                rule={r}
                fields={options.ruleFields}
                ops={options.ruleOps}
                onChange={(rule) => setRule(i, rule)}
                onRemove={() => setC({ rules: rules.filter((_, j) => j !== i) })}
              />
            ))}
            <button className={BTN_QUIET} onClick={() => setC({ rules: [...rules, { field: "status", op: "equals", value: "" }] })}>
              Add a rule
            </button>
          </div>
        </fieldset>

        <div className="space-y-2 rounded-lg border border-slate-800 p-3">
          <span className={LABEL}>Try it on a job</span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <JobPicker value={testJob} onChange={(id) => (setTestJob(id), setTest(null))} placeholder="Pick a job" />
            </div>
            <button className={BTN_QUIET} disabled={!testJob} onClick={() => void runTest()}>
              Test
            </button>
          </div>
          {test && (
            <Notice tone={test.matches ? "ok" : "info"}>
              {test.matches ? "This job matches." : "This job does not match."}{" "}
              {test.checks.map((ch) => `${ch.ok ? "✓" : "✗"} ${ch.detail}`).join("; ")}
            </Notice>
          )}
        </div>

        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <button className={BTN} disabled={busy} onClick={() => void save()}>
            Save packet
          </button>
          <button className={BTN_QUIET} onClick={onClose}>
            Cancel
          </button>
          {d.id && (
            <button className={`${BTN_DANGER} ml-auto`} onClick={() => void remove()}>
              Delete
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CheckList({
  title,
  items,
  selected,
  onToggle,
  empty,
}: {
  title: string;
  items: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  empty?: string;
}) {
  return (
    <div>
      <span className={LABEL}>{title}</span>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">{empty}</p>
      ) : (
        <div className="mt-1 flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
          {items.map((it) => (
            <label key={it.id} className="flex items-center gap-1.5 text-sm text-slate-300">
              <input type="checkbox" className="accent-sky-500" checked={selected.includes(it.id)} onChange={(e) => onToggle(it.id, e.target.checked)} />
              {it.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function RuleRow({
  rule,
  fields,
  ops,
  onChange,
  onRemove,
}: {
  rule: Rule;
  fields: { key: string; label: string }[];
  ops: RuleOp[];
  onChange: (r: Rule) => void;
  onRemove: () => void;
}) {
  const isMeta = rule.field.startsWith("metadata.");
  const needsValue = rule.op !== "exists" && rule.op !== "not_exists";
  const value = Array.isArray(rule.value) ? rule.value.join(", ") : rule.value === undefined ? "" : String(rule.value);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <select
        className={SELECT}
        aria-label="Job field"
        value={isMeta ? "metadata.<key>" : rule.field}
        onChange={(e) => onChange({ ...rule, field: e.target.value === "metadata.<key>" ? "metadata." : e.target.value })}
      >
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>
      {isMeta && (
        <input
          className={`${FIELD} sm:w-36`}
          placeholder="key"
          aria-label="Stored value's key"
          value={rule.field.slice("metadata.".length)}
          onChange={(e) => onChange({ ...rule, field: `metadata.${e.target.value.replace(/[^A-Za-z0-9_]/g, "")}` })}
        />
      )}
      <select className={SELECT} aria-label="Comparison" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as RuleOp })}>
        {ops.map((op) => (
          <option key={op} value={op}>
            {OP_LABEL[op]}
          </option>
        ))}
      </select>
      {needsValue && (
        <input
          className={`${FIELD} flex-1`}
          aria-label="Value"
          placeholder={rule.op === "in" || rule.op === "not_in" ? "a, b, c" : "value"}
          value={value}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
        />
      )}
      <button className="text-slate-400 hover:text-red-300" aria-label="Remove rule" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}
