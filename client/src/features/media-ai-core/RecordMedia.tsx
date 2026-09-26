import { useState } from "react";
import { useFeatures, useTerms } from "../../config/useConfig";
import type { ItemDetail } from "../../types";
import { setPrimaryPhoto } from "./api";
import { AttachmentGallery } from "./AttachmentGallery";
import { ReadFromLabel, applyLabelReview, type LabelDetails, type LabelTarget } from "./DataPlate";
import { errorMessage } from "./format";
import type { Attachment } from "./types";

const CARD = "space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4";

/** The most recent label reading among a record's attachments. */
function latestLabel(list: Attachment[]): LabelDetails | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const plate = list[i]!.meta.dataPlate as Partial<LabelDetails> | undefined;
    if (plate && typeof plate === "object") {
      return {
        manufactureDate: plate.manufactureDate ?? null,
        ratings: plate.ratings ?? { voltage: null, amperage: null, wattage: null, frequency: null },
        otherIdentifiers: Array.isArray(plate.otherIdentifiers) ? plate.otherIdentifiers : [],
        rawText: typeof plate.rawText === "string" ? plate.rawText : "",
      };
    }
  }
  return null;
}

function LabelFacts({ details }: { details: LabelDetails }) {
  const ratings = [details.ratings.voltage, details.ratings.amperage, details.ratings.wattage, details.ratings.frequency].filter(Boolean);
  if (!details.manufactureDate && !ratings.length && !details.otherIdentifiers.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
      {details.manufactureDate && (
        <div>
          <dt className="text-xs uppercase text-slate-500">Manufactured</dt>
          <dd className="text-slate-200">{details.manufactureDate}</dd>
        </div>
      )}
      {ratings.length > 0 && (
        <div>
          <dt className="text-xs uppercase text-slate-500">Rating</dt>
          <dd className="text-slate-200">{ratings.join(" · ")}</dd>
        </div>
      )}
      {details.otherIdentifiers.map((o, i) => (
        <div key={i}>
          <dt className="text-xs uppercase text-slate-500">{o.label}</dt>
          <dd className="font-mono text-slate-200">{o.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Photos and files for an item and its units, "Read from label", and "Set as
 * main photo". Hidden when AI capture is switched off.
 */
export function ItemMediaSection({ item, onChange }: { item: ItemDetail; onChange: (item: ItemDetail) => void }) {
  const features = useFeatures();
  const terms = useTerms();
  const [owner, setOwner] = useState<{ type: "item" | "unit"; id: string }>({ type: "item", id: item.id });
  const [refresh, setRefresh] = useState(0);
  const [label, setLabel] = useState<LabelDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!features.aiCapture) return null;

  // The owner picked may have been deleted, or belong to the item shown before.
  const units = features.units ? item.units : [];
  const current =
    owner.type === "item" || !units.some((u) => u.id === owner.id) ? { type: "item" as const, id: item.id } : owner;
  const unitName = (u: ItemDetail["units"][number]) => u.label?.trim() || u.serial?.trim() || u.assetCode;

  const itemTarget: LabelTarget = { ownerType: "item", ownerId: item.id, label: `This ${terms.item.singular.toLowerCase()}` };
  const targets: LabelTarget[] = [
    itemTarget,
    ...units.map((u) => ({ ownerType: "unit" as const, ownerId: u.id, label: `Unit: ${unitName(u)}` })),
  ];
  // Offer the record being looked at first.
  const ordered = [...targets.filter((t) => t.ownerId === current.id), ...targets.filter((t) => t.ownerId !== current.id)];

  return (
    <div className={CARD}>
      {units.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Whose files">
          {[{ type: "item" as const, id: item.id, name: terms.item.singular }, ...units.map((u) => ({ type: "unit" as const, id: u.id, name: unitName(u) }))].map(
            (o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setOwner({ type: o.type, id: o.id })}
                aria-pressed={current.id === o.id}
                className={`rounded-lg px-3 py-1 text-xs ${
                  current.id === o.id ? "bg-slate-200 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {o.name}
              </button>
            ),
          )}
        </div>
      )}
      <AttachmentGallery
        ownerType={current.type}
        ownerId={current.id}
        refreshKey={refresh}
        onChange={(list) => setLabel(latestLabel(list))}
        headerActions={
          item.category !== "Domain" && (
            <ReadFromLabel
              owner={{ ownerType: current.type, ownerId: current.id }}
              targets={ordered}
              onAccept={async (review) => {
                const updated = await applyLabelReview(review, itemTarget);
                onChange(updated);
                if (review.target) setOwner({ type: review.target.ownerType, id: review.target.ownerId });
                setRefresh((n) => n + 1);
              }}
            />
          )
        }
        actions={(a, { close }) =>
          current.type === "item" && a.mime.startsWith("image/") && a.kind === "photo" ? (
            <button
              type="button"
              onClick={async () => {
                setError(null);
                try {
                  onChange(await setPrimaryPhoto(a.id));
                  close();
                } catch (err) {
                  setError(errorMessage(err, "Could not set the main photo."));
                  close();
                }
              }}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
            >
              Set as main photo
            </button>
          ) : null
        }
      />
      {label && <LabelFacts details={label} />}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

/** Photos and files for a location. Hidden when AI capture is switched off. */
export function LocationMediaSection({ locationId }: { locationId: string }) {
  const features = useFeatures();
  if (!features.aiCapture) return null;
  return (
    <div className={CARD}>
      <AttachmentGallery ownerType="location" ownerId={locationId} />
    </div>
  );
}
