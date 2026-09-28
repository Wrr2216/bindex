import { api } from "../../api/client";
import type { ItemDetail, ItemUnit } from "../../types";
import { invalidateSummaries, useItemTags } from "./stores";
import { EpcLine, TagList } from "./ItemTagPanel";
import { identifiersKey, useTagBinder } from "./useTagBinder";
import { nfcSupported } from "./webnfc";

const MINI_BTN =
  "rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50";

/**
 * Tags on one unit of a multi-quantity item: what is bound to it, its EPC,
 * and binding a new one by desk reader or by tapping the phone.
 */
export function UnitTagActions({
  item,
  unit,
  onChange,
}: {
  item: ItemDetail;
  unit: ItemUnit;
  onChange: (i: ItemDetail) => void;
}) {
  const { data, reload } = useItemTags(item.id, identifiersKey(item));
  const binder = useTagBinder(item, onChange, unit.id);
  const mine = data?.units.find((u) => u.id === unit.id);
  const w = binder.waiting;

  const remove = async (tag: { id: string; type: string; value: string }) => {
    if (!confirm(`Remove ${tag.type.toUpperCase()} tag ${tag.value} from this unit?`)) return;
    await api.removeIdentifier(tag.id);
    await reload();
    invalidateSummaries(item.id);
    onChange(await api.getItem(item.id));
  };

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {w ? (
          <>
            <span className="animate-pulse text-xs text-sky-300">
              {w.how === "tap" ? "Hold an NFC tag to the phone…" : `Read the ${w.type.toUpperCase()} tag now…`}
            </span>
            <button onClick={binder.cancel} className={MINI_BTN}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button onClick={() => binder.bindWithReader("rfid")} className={MINI_BTN}>
              Bind RFID tag
            </button>
            {nfcSupported ? (
              <button onClick={() => void binder.bindWithTap()} className={MINI_BTN}>
                Tap NFC tag
              </button>
            ) : (
              <button onClick={() => binder.bindWithReader("nfc")} className={MINI_BTN}>
                Bind NFC tag
              </button>
            )}
          </>
        )}
        {mine && <TagList tags={mine.tags} onRemove={remove} />}
      </div>
      {mine?.epc && <EpcLine epc={mine.epc} compact />}
      {binder.message && <p className="text-xs text-emerald-400">{binder.message}</p>}
      {binder.error && <p className="text-xs text-red-400">{binder.error}</p>}
    </div>
  );
}
