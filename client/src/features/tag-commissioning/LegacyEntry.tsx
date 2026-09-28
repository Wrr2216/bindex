import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { useTerms } from "../../config/useConfig";
import { makeLocationLabel } from "../../lib/locationLabel";
import { useScan } from "../../scan/ScanProvider";
import type { Location } from "../../types";
import { BUTTON, BUTTON_QUIET, FIELD, LABEL } from "../../components/ui";
import { errorText, tagsApi } from "./api";
import { LegacyDot } from "./badges";
import { colorHex, useTagSettings } from "./stores";

type Saved = { id: string; name: string; assetCode: string; value: string; color: string; lot: string | null; number: number };

/** The stored form of a sticker, as the server writes it, for the preview. */
function stickerPreview(color: string, lot: string, number: string): string | null {
  if (!color || !/^\d{1,15}$/.test(number)) return null;
  const n = String(Number(number));
  const l = lot.trim().toUpperCase();
  if (l && !/^[A-Z0-9]{1,20}$/.test(l)) return null;
  const cleanLot = /^\d+$/.test(l) ? l.replace(/^0+(?=\d)/, "") : l;
  return cleanLot ? `${color}-${cleanLot}-${n}` : `${color}-${n}`;
}

/**
 * Bringing a site on legacy stickers into the system, one box at a time: type
 * what the box is, save, and the next sticker number is already filled in.
 * Also looks a sticker up as it is written on the box.
 */
export function LegacyEntry() {
  const terms = useTerms();
  const settings = useTagSettings();
  const { scan } = useScan();
  const [locations, setLocations] = useState<Location[]>([]);
  const [color, setColor] = useState("");
  const [lot, setLot] = useState("");
  const [number, setNumber] = useState("1");
  const [name, setName] = useState("");
  const [locationId, setLocationId] = useState("");
  const [saved, setSaved] = useState<Saved[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listLocations().then(setLocations).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!color && settings?.palette[0]) setColor(settings.palette[0].name);
  }, [settings, color]);

  const label = useMemo(() => makeLocationLabel(locations), [locations]);
  const sorted = useMemo(
    () => [...locations].sort((a, b) => label(a).localeCompare(label(b))),
    [locations, label],
  );

  const preview = stickerPreview(color, lot, number);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!preview || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await tagsApi.createFromSticker({
        name: name.trim(),
        color,
        lot: lot.trim() || null,
        number: Number(number),
        locationId: locationId || null,
      });
      setSaved((s) =>
        [{ ...res.item, value: res.value, color, lot: lot.trim() || null, number: Number(number) }, ...s].slice(0, 20),
      );
      // Same colour, lot and place; the next free number; a fresh name.
      setNumber(String(res.next.number));
      setName("");
      nameRef.current?.focus();
    } catch (err) {
      setError(errorText(err, "Could not save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <form onSubmit={save} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div>
          <h2 className="font-semibold text-slate-100">Enter stickered {terms.item.plural.toLowerCase()}</h2>
          <p className="mt-1 text-sm text-slate-400">
            One {terms.item.singular.toLowerCase()} per sticker. After each save the next number is
            filled in, so a run of boxes goes quickly.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block">
            <span className={LABEL}>Colour</span>
            <div className="mt-1 flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-4 w-4 shrink-0 rounded-full ring-1 ring-slate-500/60"
                style={{ backgroundColor: colorHex(settings?.palette, color || "x") }}
              />
              <select value={color} onChange={(e) => setColor(e.target.value)} className={FIELD}>
                {settings?.palette.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="block">
            <span className={LABEL}>Lot</span>
            <input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="Optional" className={`${FIELD} mt-1 font-mono`} />
          </label>
          <label className="block">
            <span className={LABEL}>Number</span>
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              className={`${FIELD} mt-1 font-mono`}
              required
            />
          </label>
          <label className="block">
            <span className={LABEL}>{terms.location.singular}</span>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={`${FIELD} mt-1`}>
              <option value="">None</option>
              {sorted.map((l) => (
                <option key={l.id} value={l.id}>
                  {label(l)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className={LABEL}>What is it</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Kitchen box, books"
            className={`${FIELD} mt-1`}
            required
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={busy || !preview || !name.trim()} className={BUTTON}>
            {busy ? "Saving…" : "Save and next"}
          </button>
          {preview && <span className="font-mono text-sm text-slate-400">Stored as {preview}</span>}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>

      {saved.length > 0 && (
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Just entered</h3>
          <ul className="space-y-1 text-sm">
            {saved.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <LegacyDot sticker={s} />
                <Link to={`/items/${s.id}`} className="text-sky-400 hover:underline">
                  {s.name}
                </Link>
                <span className="font-mono text-xs text-slate-500">
                  {s.value} · {s.assetCode}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (lookup.trim()) scan(lookup.trim());
        }}
        className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-5"
      >
        <h2 className="font-semibold text-slate-100">Look up a sticker</h2>
        <p className="text-sm text-slate-400">Type it as it reads on the box, such as RED 1234 056.</p>
        <div className="flex gap-2">
          <input
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Colour, lot, number"
            aria-label="Sticker to look up"
            className={`${FIELD} font-mono`}
          />
          <button className={BUTTON_QUIET}>Find</button>
        </div>
      </form>
    </div>
  );
}
