import { useCallback, useEffect, useState } from "react";
import { documentsApi, type CustomFieldInput } from "./api";
import type { CustomField, FieldType } from "./types";
import { BTN, BTN_DANGER, BTN_QUIET, CARD, LIST, DocumentsNav, FIELD, LABEL, Notice, SELECT, errorText, keyFromLabel, useIsAdmin } from "./ui";

/**
 * The custom field library: definitions made once and dropped into any
 * template. One key per meaning ("site_contact") is what lets a new document
 * copy values from an earlier one.
 */

const TYPES: { type: FieldType; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "date", label: "Date" },
  { type: "checkbox", label: "Tick box" },
  { type: "select", label: "List of choices" },
  { type: "signature", label: "Signature" },
  { type: "initials", label: "Initials" },
];

type Draft = CustomFieldInput & { id: string | null; optionsText: string; keyTouched: boolean };

const blank = (): Draft => ({ id: null, key: "", label: "", type: "text", required: false, optionsText: "", keyTouched: false, active: true });

export function FieldsPage() {
  const admin = useIsAdmin();
  const [fields, setFields] = useState<CustomField[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    documentsApi
      .fields(true)
      .then(setFields)
      .catch((err) => setMessage({ tone: "error", text: errorText(err, "The field library could not be loaded.") }));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    const { id, optionsText, keyTouched: _k, ...rest } = draft;
    const input: CustomFieldInput = {
      ...rest,
      options: draft.type === "select" ? optionsText.split("\n").map((o) => o.trim()).filter(Boolean) : undefined,
    };
    // Null, not a missing key, is what clears a setting on an existing field.
    const clearable = input as Record<string, unknown>;
    for (const k of ["min", "max", "help", "statement", "placeholder"]) clearable[k] ??= null;
    try {
      if (id) await documentsApi.updateField(id, input);
      else await documentsApi.createField(input);
      setDraft(null);
      setMessage({ tone: "ok", text: `Saved ${input.label}. Templates already using it keep their copy until you insert it again.` });
      load();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "The field could not be saved.") });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: CustomField) => {
    if (!window.confirm(`Remove "${f.label}" from the library? Templates keep their copies.`)) return;
    try {
      await documentsApi.deleteField(f.id);
      load();
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };

  if (!admin) return <Notice tone="warn">Only an administrator can manage the field library.</Notice>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">Field library</h1>
        <button className={BTN} onClick={() => setDraft(blank())}>
          New field
        </button>
      </div>
      <DocumentsNav />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {draft && (
        <section className={`${CARD} space-y-3`} aria-label="Field">
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className={LABEL}>Label</span>
              <input
                className={`${FIELD} mt-1`}
                value={draft.label}
                maxLength={200}
                onChange={(e) =>
                  setDraft({ ...draft, label: e.target.value, key: draft.keyTouched || draft.id ? draft.key : keyFromLabel(e.target.value) })
                }
              />
            </label>
            <label>
              <span className={LABEL}>Key</span>
              <input
                className={`${FIELD} mt-1 font-mono`}
                value={draft.key}
                maxLength={40}
                onChange={(e) => setDraft({ ...draft, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"), keyTouched: true })}
              />
            </label>
            <label>
              <span className={LABEL}>Type</span>
              <select className={`${SELECT} mt-1 w-full`} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as FieldType })}>
                {TYPES.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-end gap-4 pb-2 text-sm text-slate-300">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-sky-500" checked={!!draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
                Required
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-sky-500" checked={draft.active !== false} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                Offered in the editor
              </label>
              {draft.type === "text" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="accent-sky-500" checked={!!draft.multiline} onChange={(e) => setDraft({ ...draft, multiline: e.target.checked })} />
                  Several lines
                </label>
              )}
            </div>
            {draft.type === "select" && (
              <label className="sm:col-span-2">
                <span className={LABEL}>Choices, one per line</span>
                <textarea className={`${FIELD} mt-1`} rows={3} value={draft.optionsText} onChange={(e) => setDraft({ ...draft, optionsText: e.target.value })} />
              </label>
            )}
            {draft.type === "number" && (
              <div className="flex gap-2 sm:col-span-2">
                <label className="flex-1">
                  <span className={LABEL}>Minimum</span>
                  <input
                    className={`${FIELD} mt-1`}
                    type="number"
                    value={draft.min ?? ""}
                    onChange={(e) => setDraft({ ...draft, min: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </label>
                <label className="flex-1">
                  <span className={LABEL}>Maximum</span>
                  <input
                    className={`${FIELD} mt-1`}
                    type="number"
                    value={draft.max ?? ""}
                    onChange={(e) => setDraft({ ...draft, max: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </label>
              </div>
            )}
            {(draft.type === "signature" || draft.type === "initials") && (
              <label className="sm:col-span-2">
                <span className={LABEL}>What the signer agrees to</span>
                <input className={`${FIELD} mt-1`} value={draft.statement ?? ""} maxLength={2000} onChange={(e) => setDraft({ ...draft, statement: e.target.value })} />
              </label>
            )}
            <label className="sm:col-span-2">
              <span className={LABEL}>Help text</span>
              <input className={`${FIELD} mt-1`} value={draft.help ?? ""} maxLength={500} onChange={(e) => setDraft({ ...draft, help: e.target.value })} />
            </label>
          </div>
          <div className="flex gap-2">
            <button className={BTN} disabled={busy || !draft.label.trim() || !draft.key} onClick={() => void save()}>
              Save field
            </button>
            <button className={BTN_QUIET} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      {fields && fields.length === 0 && !draft && <Notice>No fields in the library yet.</Notice>}
      {fields && fields.length > 0 && (
        <ul className={LIST}>
          {fields.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className={`block font-medium ${f.active ? "text-slate-100" : "text-slate-500"}`}>
                  {f.label}
                  {f.required && <span className="text-red-400"> *</span>}
                </span>
                <span className="block font-mono text-xs text-slate-500">
                  {f.key} · {TYPES.find((t) => t.type === f.type)?.label}
                  {f.definition.options ? ` · ${f.definition.options.join(" / ")}` : ""}
                </span>
              </span>
              <button
                className={BTN_QUIET}
                onClick={() =>
                  setDraft({
                    id: f.id,
                    key: f.key,
                    label: f.label,
                    type: f.type,
                    required: f.required,
                    active: f.active,
                    multiline: f.definition.multiline,
                    min: f.definition.min,
                    max: f.definition.max,
                    help: f.definition.help,
                    statement: f.definition.statement,
                    optionsText: (f.definition.options ?? []).join("\n"),
                    keyTouched: true,
                  })
                }
              >
                Edit
              </button>
              <button className={BTN_DANGER} onClick={() => void remove(f)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
