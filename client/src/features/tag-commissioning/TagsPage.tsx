import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useFeatures, useTerms } from "../../config/useConfig";
import { BUTTON, BUTTON_QUIET } from "../../components/ui";
import { BulkBind } from "./BulkBind";
import { Coverage } from "./Coverage";
import { LegacyEntry } from "./LegacyEntry";
import { TagSettingsSection } from "./TagSettingsSection";
import { NFC_HINT, nfc, nfcSupported, useNfcState } from "./webnfc";

type Tab = "bind" | "coverage" | "stickers" | "settings";

function TapLookup() {
  const terms = useTerms();
  const state = useNfcState();
  if (!nfcSupported) return <p className="text-sm text-slate-500">{NFC_HINT}</p>;
  const on = state.status === "on";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex-1">
        <p className="font-medium text-slate-100">Tap to look up</p>
        <p className="text-sm text-slate-400">
          {on
            ? `On. Tap any tagged ${terms.item.singular.toLowerCase()} to the back of the phone, from any screen.`
            : `Tap a tag to the phone to open the ${terms.item.singular.toLowerCase()} it belongs to. Unknown tags can be bound on the spot.`}
        </p>
        {state.error && <p className="mt-1 text-sm text-red-400">{state.error}</p>}
      </div>
      <button onClick={() => (on ? nfc.stop() : void nfc.start())} className={on ? BUTTON_QUIET : BUTTON}>
        {on ? "Stop" : "Start tapping"}
      </button>
    </div>
  );
}

/**
 * Tag commissioning: binding tags in bulk, the RFID coverage of each
 * location, legacy sticker entry, and (for administrators) how EPCs are
 * numbered and which sticker colours exist.
 */
export function TagsPage() {
  const features = useFeatures();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const isAdmin = user?.role === "admin";

  const tabs: { id: Tab; label: string }[] = [
    { id: "bind", label: "Bulk binding" },
    { id: "coverage", label: "Coverage" },
    ...(features.legacyTags ? [{ id: "stickers" as const, label: "Legacy stickers" }] : []),
    ...(isAdmin ? [{ id: "settings" as const, label: "Settings" }] : []),
  ];
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = tabs.some((t) => t.id === requested) ? requested! : "bind";

  const go = (next: Tab, extra: Record<string, string> = {}) => setParams({ tab: next, ...extra });

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold text-slate-100">Tags</h1>
      <TapLookup />
      <nav className="flex flex-wrap gap-1 border-b border-slate-800" aria-label="Tag tools">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => go(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.id
                ? "border-sky-400 text-sky-300"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "bind" && (
        <BulkBind
          sessionId={params.get("session")}
          onOpen={(id) => go("bind", id ? { session: id } : {})}
        />
      )}
      {tab === "coverage" && <Coverage />}
      {tab === "stickers" && <LegacyEntry />}
      {tab === "settings" && <TagSettingsSection />}
    </div>
  );
}
