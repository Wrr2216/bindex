import { useEffect, useState } from "react";
import { BUTTON, Field, FIELD, Pill, Section } from "../../components/ui";
import { conditionApi } from "./api";
import type { ConditionSettings } from "./types";
import { errorMessage, forgetConditionSettings, useConditionEnabled } from "./vocab";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Settings → Condition and containers (administrators): the size classes and
 * content categories container capture offers and the model is asked to use,
 * and a note added to every prompt.
 */
export function ConditionSettingsSection() {
  const enabled = useConditionEnabled();
  const [saved, setSaved] = useState<ConditionSettings | null>(null);
  const [sizes, setSizes] = useState("");
  const [categories, setCategories] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const apply = (s: ConditionSettings) => {
    setSaved(s);
    setSizes(s.sizeClasses.join("\n"));
    setCategories(s.categories.join("\n"));
    setHint(s.promptHint);
  };

  useEffect(() => {
    if (!enabled) return;
    conditionApi.settings().then(apply).catch(() => undefined);
  }, [enabled]);

  if (!enabled) return null;

  const dirty =
    saved !== null &&
    (lines(sizes).join("\n") !== saved.sizeClasses.join("\n") ||
      lines(categories).join("\n") !== saved.categories.join("\n") ||
      hint.trim() !== saved.promptHint);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      apply(await conditionApi.saveSettings({ sizeClasses: lines(sizes), categories: lines(categories), promptHint: hint }));
      forgetConditionSettings();
      setMessage({ tone: "ok", text: "Saved." });
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err, "Could not save.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Condition and containers"
      description="The container sizes and content categories people pick from, which the vision model is also told to use. Clear a list to go back to the defaults."
      aside={<Pill tone={saved?.vision ? "on" : "off"}>{saved?.vision ? "Vision model configured" : "No vision model"}</Pill>}
    >
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Container sizes" hint="One per line, such as small, wardrobe, tote, pallet.">
          <textarea value={sizes} onChange={(e) => setSizes(e.target.value)} rows={8} className={FIELD} />
        </Field>
        <Field label="Content categories" hint="One per line. Contents are sorted into these.">
          <textarea value={categories} onChange={(e) => setCategories(e.target.value)} rows={8} className={FIELD} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label="Notes for the AI" hint="Added to every condition and container prompt, such as how your totes are marked. Up to 1000 characters.">
          <textarea value={hint} onChange={(e) => setHint(e.target.value)} rows={3} maxLength={1000} className={FIELD} />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={busy || !dirty} className={BUTTON}>
          Save
        </button>
        {message && <span className={`text-sm ${message.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>{message.text}</span>}
      </div>
    </Section>
  );
}
