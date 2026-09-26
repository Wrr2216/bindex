import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUTTON, BUTTON_QUIET, FIELD, Field, Pill, Section } from "../../components/ui";
import { useAiAvailability } from "../media-ai-core";
import { errorMessage } from "../media-ai-core/format";
import { captureApi } from "./api";
import type { BulkCaptureSettings, DeskTemplate } from "./types";

/** Settings, AI bulk capture: the cost cap per session and the desk templates. For administrators. */
export function BulkCaptureSettingsSection() {
  const ai = useAiAvailability();
  const [saved, setSaved] = useState<BulkCaptureSettings | null>(null);
  const [cap, setCap] = useState("");
  const [templates, setTemplates] = useState<DeskTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    captureApi
      .settings()
      .then((s) => {
        setSaved(s);
        setCap(String(s.maxImagesPerSession));
        setTemplates(s.deskTemplates);
      })
      .catch((err) => setMessage(errorMessage(err, "Could not load the bulk capture settings.")));
  }, []);

  const dirty =
    saved !== null &&
    (Number(cap) !== saved.maxImagesPerSession || JSON.stringify(templates) !== JSON.stringify(saved.deskTemplates));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const s = await captureApi.saveSettings({
        maxImagesPerSession: Number(cap),
        deskTemplates: templates.map((t) => ({
          ...t,
          items: t.items.map((i) => ({
            ...i,
            match: i.match.flatMap((m) => m.split(",")).map((m) => m.trim()).filter(Boolean),
          })),
        })),
      });
      setSaved(s);
      setCap(String(s.maxImagesPerSession));
      setTemplates(s.deskTemplates);
      setMessage("Saved.");
    } catch (err) {
      setMessage(errorMessage(err, "Could not save."));
    } finally {
      setBusy(false);
    }
  };

  const setTemplate = (i: number, t: DeskTemplate) => setTemplates((all) => all.map((x, j) => (j === i ? t : x)));

  return (
    <Section
      title="AI bulk capture"
      description="Walkthroughs, desk surveys and paper inventories read by the vision model. Every image analysed is one paid request, so each session has a cap."
      aside={<Pill tone={ai.vision ? "on" : "off"}>{ai.vision ? "Vision model ready" : "No vision model"}</Pill>}
    >
      {saved === null ? (
        message && <p className="mt-4 text-sm text-red-400">{message}</p>
      ) : (
        <div className="mt-4 space-y-5">
          <div className="max-w-xs">
            <Field label="Most images per session" hint="New sessions start at this cap, and none can raise theirs above it. At most 500.">
              <input type="number" min={1} max={500} value={cap} onChange={(e) => setCap(e.target.value)} className={FIELD} />
            </Field>
          </div>

          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-200">Desk templates</p>
            <p className="text-xs text-slate-500">
              What a standard desk should have. A desk survey flags every desk that is short of one of these. Match words
              are the names that count towards a line: a “monitor” line also counts displays and screens.
            </p>
            {templates.map((t, i) => (
              <TemplateEditor
                key={i}
                template={t}
                onChange={(next) => setTemplate(i, next)}
                onRemove={templates.length > 1 ? () => setTemplates((all) => all.filter((_, j) => j !== i)) : undefined}
              />
            ))}
            <button
              type="button"
              className={BUTTON_QUIET}
              onClick={() =>
                setTemplates((all) => [
                  ...all,
                  { id: "", name: "New template", items: [{ key: "", label: "Monitor", qty: 1, match: ["monitor", "display"] }] },
                ])
              }
            >
              Add template
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={BUTTON} disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <Link to="/capture" className={BUTTON_QUIET}>
              Open bulk capture
            </Link>
            {message && <span className="text-sm text-slate-400">{message}</span>}
          </div>
        </div>
      )}
    </Section>
  );
}

function TemplateEditor({
  template: t,
  onChange,
  onRemove,
}: {
  template: DeskTemplate;
  onChange: (t: DeskTemplate) => void;
  onRemove?: () => void;
}) {
  const setItem = (i: number, patch: Partial<DeskTemplate["items"][number]>) =>
    onChange({ ...t, items: t.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <div className="space-y-2 rounded-lg border border-slate-800 p-3">
      <div className="flex items-center gap-2">
        <input
          value={t.name}
          onChange={(e) => onChange({ ...t, name: e.target.value })}
          aria-label="Template name"
          className={`${FIELD} max-w-xs`}
        />
        {onRemove && (
          <button type="button" className="text-sm text-red-300 hover:underline" onClick={onRemove}>
            Remove template
          </button>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-1 pr-2 font-medium">Item</th>
            <th className="w-20 py-1 pr-2 font-medium">Count</th>
            <th className="py-1 pr-2 font-medium">Match words</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {t.items.map((item, i) => (
            <tr key={i}>
              <td className="py-1 pr-2">
                <input value={item.label} onChange={(e) => setItem(i, { label: e.target.value })} aria-label="Item" className={FIELD} />
              </td>
              <td className="py-1 pr-2">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={item.qty}
                  onChange={(e) => setItem(i, { qty: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
                  aria-label="Count"
                  className={FIELD}
                />
              </td>
              <td className="py-1 pr-2">
                <input
                  value={item.match.join(", ")}
                  // Kept as typed until saved, so commas and spaces can be typed freely.
                  onChange={(e) => setItem(i, { match: [e.target.value] })}
                  aria-label="Match words"
                  className={FIELD}
                />
              </td>
              <td className="py-1 text-right">
                {t.items.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.label}`}
                    className="text-slate-500 hover:text-red-300"
                    onClick={() => onChange({ ...t, items: t.items.filter((_, j) => j !== i) })}
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="text-sm text-sky-400 hover:underline"
        onClick={() => onChange({ ...t, items: [...t.items, { key: "", label: "", qty: 1, match: [] }] })}
      >
        Add a line
      </button>
    </div>
  );
}
