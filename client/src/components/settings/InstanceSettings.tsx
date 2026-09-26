import { useState } from "react";
import { api } from "../../api/client";
import { useConfig } from "../../config/useConfig";
import type { AppConfig, Features } from "../../types";
import { BUTTON, FIELD, Field, Section, Toggle } from "../ui";

/**
 * Naming, vocabulary and feature switches. Everything here is stored in the
 * database, so a deployment adapts without editing code or restarting.
 */

type TermKey = keyof AppConfig["terms"];

const TERM_HELP: Record<TermKey, string> = {
  item: "A single thing you track.",
  location: "Where things live: a room, a shelf, a tote.",
  group: "Optional ownership grouping. A company, a household, a site.",
  holder: "Who something is checked out to.",
};

const FEATURE_LABELS: { key: keyof Features; title: string; description: string }[] = [
  {
    key: "groups",
    title: "Groups",
    description: "Group locations and items by owner. Turn off for a single-owner instance.",
  },
  {
    key: "holders",
    title: "Assignees",
    description: "Track who has something out.",
  },
  {
    key: "assignments",
    title: "Check-out history",
    description: "Keep a record of every check-out and return.",
  },
  {
    key: "units",
    title: "Tracked units",
    description: "Give each physical copy of a multi-quantity item its own code and serial.",
  },
  {
    key: "audit",
    title: "Audit and verify",
    description: "Reconcile a container, or walk a whole building, against what is on file.",
  },
  {
    key: "spotCheck",
    title: "Spot check on retrieval",
    description:
      "When a container moves, ask whether a random item from it was really there. Confirmed items are logged; unconfirmed ones are flagged.",
  },
  {
    key: "printing",
    title: "Label printing",
    description: "Print labels and contents sheets from the browser.",
  },
  {
    key: "domains",
    title: "Domain names",
    description: "Track domains as inventory, with expiry dates and registrar sync.",
  },
  {
    key: "vehicleFields",
    title: "Vehicle fields",
    description:
      "Extra fields on an item for a vehicle or powered equipment: VIN, plate, title, registration and insurance.",
  },
  {
    key: "lookup",
    title: "Product lookup",
    description: "Fill in an unknown barcode from a product database.",
  },
  {
    key: "askSearch",
    title: "Search by question",
    description:
      "Type what you are looking for instead of setting filters. Needs a language model to be configured.",
  },
  {
    key: "tracking",
    title: "Readers, beacons and trackers",
    description:
      "Register fixed RFID readers, dock portals and other devices, and see where things were last detected.",
  },
  {
    key: "aiCapture",
    title: "AI capture from photos",
    description:
      "Photos, video and files on every record, and reading serial numbers and data plates from a photo of the label. Reading labels needs a vision model to be configured.",
  },
  {
    key: "jobs",
    title: "Projects, jobs and shipments",
    description:
      "Plan moves and deliveries as jobs, print floor and department manifests, and scan everything through pack, load, deliver and place.",
  },
  {
    key: "inspections",
    title: "Site inspections",
    description:
      "Survey a building's walls, doors, floors, docks and elevators before and after a move, compare the two, collect sign-off and share the report. Reading damage from a photo needs a vision model.",
  },
];

export function InstanceSettings() {
  const { config, reload } = useConfig();
  const [draft, setDraft] = useState<AppConfig>(config);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  const set = <K extends keyof AppConfig>(key: K, value: AppConfig[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setTerm = (key: TermKey, part: "singular" | "plural", value: string) =>
    setDraft((d) => ({ ...d, terms: { ...d.terms, [key]: { ...d.terms[key], [part]: value } } }));

  const setFeature = (key: keyof Features, value: boolean) =>
    setDraft((d) => ({ ...d, features: { ...d.features, [key]: value } }));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.saveConfig({
        appName: draft.appName,
        orgName: draft.orgName,
        tagline: draft.tagline,
        accentColor: draft.accentColor,
        assetCodePrefix: draft.assetCodePrefix,
        locationCodePrefix: draft.locationCodePrefix,
        currency: draft.currency,
        locale: draft.locale,
        terms: draft.terms,
        features: draft.features,
      });
      await reload();
      setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="Identity"
        description="What this instance is called and how printed codes look."
      >
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input
              className={FIELD}
              value={draft.appName}
              onChange={(e) => set("appName", e.target.value)}
            />
          </Field>
          <Field label="Organisation" hint="Optional. Shown under the name on the sign-in screen.">
            <input
              className={FIELD}
              value={draft.orgName}
              onChange={(e) => set("orgName", e.target.value)}
            />
          </Field>
          <Field label="Tagline">
            <input
              className={FIELD}
              value={draft.tagline}
              onChange={(e) => set("tagline", e.target.value)}
            />
          </Field>
          <Field label="Accent colour">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Accent colour"
                className="h-10 w-14 cursor-pointer rounded border border-slate-700 bg-slate-800"
                value={draft.accentColor}
                onChange={(e) => set("accentColor", e.target.value)}
              />
              <input
                className={FIELD}
                value={draft.accentColor}
                onChange={(e) => set("accentColor", e.target.value)}
              />
            </div>
          </Field>
          <Field
            label="Item code prefix"
            hint={`New codes look like ${draft.assetCodePrefix || "INV"}-4F2K1B. Codes already printed keep their old prefix.`}
          >
            <input
              className={FIELD}
              maxLength={8}
              value={draft.assetCodePrefix}
              onChange={(e) => set("assetCodePrefix", e.target.value.toUpperCase())}
            />
          </Field>
          <Field
            label="Location code prefix"
            hint={`Location labels read ${draft.locationCodePrefix || "LOC"}-A1B2C3.`}
          >
            <input
              className={FIELD}
              maxLength={8}
              value={draft.locationCodePrefix}
              onChange={(e) => set("locationCodePrefix", e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Currency" hint="Three-letter code, such as USD, EUR or GBP.">
            <input
              className={FIELD}
              maxLength={3}
              value={draft.currency}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Locale" hint="Controls number and date formatting, such as en-US or de-DE.">
            <input
              className={FIELD}
              value={draft.locale}
              onChange={(e) => set("locale", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Vocabulary"
        description="Rename the concepts to match how you talk about your own things."
      >
        <div className="mt-4 space-y-4">
          {(Object.keys(draft.terms) as TermKey[]).map((key) => (
            <div key={key} className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr] sm:items-end">
              <Field label={`${key} (singular)`}>
                <input
                  className={FIELD}
                  value={draft.terms[key].singular}
                  onChange={(e) => setTerm(key, "singular", e.target.value)}
                />
              </Field>
              <Field label={`${key} (plural)`}>
                <input
                  className={FIELD}
                  value={draft.terms[key].plural}
                  onChange={(e) => setTerm(key, "plural", e.target.value)}
                />
              </Field>
              <p className="text-sm text-slate-500 sm:pb-2">{TERM_HELP[key]}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Features" description="Switch off anything this instance does not need.">
        <div className="mt-4 divide-y divide-slate-800">
          {FEATURE_LABELS.map((f) => (
            <div key={f.key} className="flex items-start justify-between gap-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-200">{f.title}</p>
                <p className="text-sm text-slate-500">{f.description}</p>
              </div>
              <Toggle
                label={f.title}
                checked={draft.features[f.key]}
                onChange={(next) => setFeature(f.key, next)}
              />
            </div>
          ))}
        </div>
      </Section>

      <div className="sticky bottom-4 flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/95 px-5 py-3 backdrop-blur">
        <button onClick={save} disabled={!dirty || busy} className={BUTTON}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {dirty && !busy && <span className="text-sm text-slate-400">Unsaved changes</span>}
        {message && <span className="text-sm text-slate-400">{message}</span>}
      </div>
    </>
  );
}
