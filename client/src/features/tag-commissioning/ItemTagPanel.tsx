import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { ItemDetail } from "../../types";
import { CloseIcon, TagIcon } from "../../components/icons";
import { errorText, tagsApi } from "./api";
import { LegacyDot, TIER_HELP, TierBadge } from "./badges";
import { invalidateSummaries, useItemTags, useTagSettings } from "./stores";
import type { BoundTag, EpcView } from "./types";
import { identifiersKey, useTagBinder } from "./useTagBinder";
import { nfcSupported } from "./webnfc";

const H2 = "text-sm font-semibold uppercase tracking-wide text-slate-400";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
const FIELD =
  "rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 placeholder-slate-500";

export function EpcLine({ epc, compact = false }: { epc: EpcView; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(epc.epc);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Without a secure context the EPC is still on screen to select.
    }
  };
  return (
    <div className={compact ? "text-xs" : "text-sm"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase text-slate-500">EPC</span>
        <code className="break-all font-mono text-slate-200">{epc.epc}</code>
        <button onClick={copy} className="rounded border border-slate-700 px-1.5 text-xs text-slate-300 hover:bg-slate-800">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {!compact && (
        <p className="mt-0.5 text-xs text-slate-500">
          {epc.scheme === "giai-96" ? (
            <>
              GIAI-96 <span className="font-mono">{epc.uri}</span>
            </>
          ) : (
            "Private 96-bit EPC carrying the printed code"
          )}
          {" · "}
          {epc.encodedAt
            ? `sent to an encoder ${new Date(epc.encodedAt).toLocaleDateString()}, fixed`
            : "not encoded yet; Print and encode writes it"}
        </p>
      )}
    </div>
  );
}

export function TagList({ tags, onRemove }: { tags: BoundTag[]; onRemove: (t: BoundTag) => void }) {
  if (!tags.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <li
          key={t.id}
          className="inline-flex items-center gap-1.5 rounded bg-slate-800/80 px-2 py-0.5 font-mono text-xs text-slate-200"
        >
          <span className="text-[10px] uppercase text-slate-500">{t.type}</span>
          {t.value}
          <button
            onClick={() => onRemove(t)}
            aria-label={`Remove ${t.type} tag ${t.value}`}
            className="text-slate-500 hover:text-red-400"
          >
            <CloseIcon className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function LegacyEditor({
  item,
  onSaved,
}: {
  item: ItemDetail;
  onSaved: () => Promise<void>;
}) {
  const settings = useTagSettings();
  const { data } = useItemTags(item.id, identifiersKey(item));
  const current = data?.legacy[0] ?? null;
  const [editing, setEditing] = useState(false);
  const [color, setColor] = useState("");
  const [lot, setLot] = useState("");
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setColor(current?.color ?? settings?.palette[0]?.name ?? "");
    setLot(current?.lot ?? "");
    setNumber(current ? String(current.number) : "");
  }, [editing, current, settings]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const n = Number(number);
    if (!number.trim() || !Number.isInteger(n) || n < 0) {
      setError("The sticker number is a whole number.");
      return;
    }
    setBusy(true);
    try {
      await tagsApi.setLegacy(item.id, color, lot.trim() || null, n);
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError(errorText(err, "Could not save the sticker"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("Remove the sticker number from this record?")) return;
    await tagsApi.removeLegacy(item.id);
    await onSaved();
  };

  return (
    <div>
      <p className="mb-1 text-xs uppercase text-slate-500">Legacy sticker</p>
      {!editing ? (
        <div className="flex flex-wrap items-center gap-2">
          {current ? (
            <>
              <LegacyDot sticker={current} />
              <span className="font-mono text-sm text-slate-300">{current.value}</span>
              <button onClick={() => setEditing(true)} className="text-xs text-sky-400 hover:underline">
                Change
              </button>
              <button onClick={remove} className="text-xs text-slate-500 hover:text-red-400">
                Remove
              </button>
            </>
          ) : (
            <button onClick={() => setEditing(true)} className={BTN}>
              Add sticker number
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <select value={color} onChange={(e) => setColor(e.target.value)} aria-label="Sticker colour" className={FIELD}>
            {settings?.palette.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name.toLowerCase()}
              </option>
            ))}
          </select>
          <input
            value={lot}
            onChange={(e) => setLot(e.target.value)}
            placeholder="Lot (optional)"
            aria-label="Sticker lot"
            className={`${FIELD} w-32 font-mono`}
          />
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            placeholder="Number"
            aria-label="Sticker number"
            className={`${FIELD} w-24 font-mono`}
            autoFocus
          />
          <button disabled={busy} className={BTN_PRIMARY}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setEditing(false)} className={BTN}>
            Cancel
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  );
}

/**
 * Tags on the item page: how it can be identified (its tier), what to do to
 * move it up, the tags and sticker on it, and the EPC it gets when encoded.
 */
export function ItemTagPanel({ item, onChange }: { item: ItemDetail; onChange: (i: ItemDetail) => void }) {
  const features = useFeatures();
  const terms = useTerms();
  const { data, error: loadError, reload } = useItemTags(item.id, identifiersKey(item));
  const binder = useTagBinder(item, onChange);

  if (item.category === "Domain") return null;
  if (!data) {
    return loadError ? <p className="text-sm text-red-400">{loadError}</p> : null;
  }

  const refresh = async () => {
    await reload();
    invalidateSummaries(item.id);
    onChange(await api.getItem(item.id));
  };

  const remove = async (tag: { id: string; type: string; value: string }) => {
    if (!confirm(`Remove ${tag.type.toUpperCase()} tag ${tag.value} from this ${terms.item.singular.toLowerCase()}?`)) return;
    await api.removeIdentifier(tag.id);
    await refresh();
  };

  const hasRfid = data.tier === "rfid" || data.tier === "rfid_nfc";
  const unitTags = data.units.flatMap((u) => u.tags);
  const w = binder.waiting;

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={H2}>Tags</h2>
        <TierBadge tier={data.tier} />
      </div>
      <p className="text-sm text-slate-400">{TIER_HELP[data.tier]}</p>

      {/* The next step up the ladder: legacy or barcode, then RFID, then RFID + NFC. */}
      {w ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="animate-pulse text-sm text-sky-300">
            {w.how === "tap" ? "Hold an NFC tag to the back of the phone…" : `Read the ${w.type.toUpperCase()} tag now…`}
          </span>
          <button onClick={binder.cancel} className={BTN}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {!hasRfid && (
            <>
              <button onClick={() => binder.bindWithReader("rfid")} className={BTN_PRIMARY}>
                <TagIcon className="h-4 w-4" />
                Read an RFID tag
              </button>
              {features.printing && (
                <button onClick={() => window.open(`/print?id=${item.id}`, "_blank", "noopener")} className={BTN}>
                  Print and encode
                </button>
              )}
            </>
          )}
          {nfcSupported ? (
            <button onClick={() => void binder.bindWithTap()} className={hasRfid ? BTN_PRIMARY : BTN}>
              Tap an NFC tag to bind
            </button>
          ) : (
            <button onClick={() => binder.bindWithReader("nfc")} className={hasRfid ? BTN_PRIMARY : BTN}>
              Read an NFC tag with a reader
            </button>
          )}
          {hasRfid && (
            <button onClick={() => binder.bindWithReader("rfid")} className={BTN}>
              Add another RFID tag
            </button>
          )}
        </div>
      )}
      {binder.message && <p className="text-sm text-emerald-400">{binder.message}</p>}
      {binder.error && <p className="text-sm text-red-400">{binder.error}</p>}

      <TagList tags={data.tags} onRemove={remove} />
      {unitTags.length > 0 && (
        <p className="text-xs text-slate-500">
          {unitTags.length} more tag{unitTags.length === 1 ? " is" : "s are"} on individual units, listed with each unit.
        </p>
      )}

      {data.epc && <EpcLine epc={data.epc} />}

      {features.legacyTags && <LegacyEditor item={item} onSaved={refresh} />}
    </section>
  );
}
