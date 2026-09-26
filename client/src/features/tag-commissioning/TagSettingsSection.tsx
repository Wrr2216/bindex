import { useEffect, useState } from "react";
import { useFeatures } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET, FIELD, Field, Section } from "../../components/ui";
import { CloseIcon } from "../../components/icons";
import { errorText, tagsApi } from "./api";
import { setTagSettings, useTagSettings } from "./stores";
import type { PaletteColor } from "./types";

/** Administrator settings: the EPC scheme and the sticker colours. */
export function TagSettingsSection() {
  const features = useFeatures();
  const settings = useTagSettings();
  const [prefix, setPrefix] = useState("");
  const [palette, setPalette] = useState<PaletteColor[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setPrefix(settings.gs1CompanyPrefix);
    setPalette(settings.palette);
  }, [settings]);

  if (!settings) return <p className="text-slate-500">Loading…</p>;

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await tagsApi.saveSettings({
        gs1CompanyPrefix: prefix.trim(),
        ...(features.legacyTags ? { palette } : {}),
      });
      setTagSettings(next);
      setMessage("Saved.");
    } catch (err) {
      setError(errorText(err, "Could not save"));
    } finally {
      setBusy(false);
    }
  };

  const edit = (i: number, patch: Partial<PaletteColor>) =>
    setPalette((p) => p.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-5">
      <Section
        title="RFID encoding"
        description="The EPC written to tags by Print and encode. With a GS1 company prefix, each record gets a GIAI-96 EPC under your prefix. Without one, a private 96-bit EPC that carries the printed code."
      >
        <div className="mt-4 max-w-sm">
          <Field
            label="GS1 company prefix"
            hint="6 to 12 digits, leading zeros included. Leave empty for the private scheme. EPCs already sent to an encoder never change."
          >
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              placeholder="e.g. 0614141"
              className={`${FIELD} font-mono`}
            />
          </Field>
        </div>
        <p className="mt-2 text-sm text-slate-400">
          New EPCs use <span className="font-mono">{settings.epcScheme === "giai-96" ? "GIAI-96" : "the private scheme"}</span>.
        </p>
      </Section>

      {features.legacyTags && (
        <Section
          title="Sticker colours"
          description="The colours a legacy sticker can be. The name becomes the first part of the stored number (RED-1234-56), so use one word."
        >
          <ul className="mt-4 space-y-2">
            {palette.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  type="color"
                  value={c.hex}
                  onChange={(e) => edit(i, { hex: e.target.value })}
                  aria-label={`${c.name} colour`}
                  className="h-9 w-12 cursor-pointer rounded border border-slate-700 bg-slate-800"
                />
                <input
                  value={c.name}
                  onChange={(e) => edit(i, { name: e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase() })}
                  aria-label="Colour name"
                  className={`${FIELD} max-w-48 font-mono`}
                />
                <button
                  onClick={() => setPalette((p) => p.filter((_, j) => j !== i))}
                  disabled={palette.length === 1}
                  aria-label={`Remove ${c.name}`}
                  className="text-slate-500 hover:text-red-400 disabled:opacity-30"
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => setPalette((p) => [...p, { name: "", hex: "#64748b" }])}
            className={`${BUTTON_QUIET} mt-3`}
          >
            Add a colour
          </button>
        </Section>
      )}

      <div className="flex items-center gap-3">
        <button onClick={() => void save()} disabled={busy} className={BUTTON}>
          {busy ? "Saving…" : "Save"}
        </button>
        {message && <span className="text-sm text-emerald-400">{message}</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}
