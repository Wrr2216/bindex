import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { ItemDetail } from "../../types";
import { useScan } from "../../scan/ScanProvider";
import { errorText, tagsApi } from "./api";
import { useItemTags } from "./stores";
import type { TagType } from "./types";
import { nfc, nfcSupported } from "./webnfc";

export type BindWait = { how: "reader" | "tap"; type: TagType } | null;

/**
 * Bind the next tag to an item or one of its units: read by a desk reader
 * (anything that types, or the networked reader) through the app's scan
 * capture, or tapped on this phone. After a bind the item is reloaded so its
 * identifier list shows the new tag.
 */
export function useTagBinder(item: ItemDetail, onChange: (i: ItemDetail) => void, unitId: string | null = null) {
  const { armCapture } = useScan();
  const { reload } = useItemTags(item.id, identifiersKey(item));
  const [waiting, setWaiting] = useState<BindWait>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const release = useRef<(() => void) | null>(null);

  const stopWaiting = useCallback(() => {
    release.current?.();
    release.current = null;
    setWaiting(null);
  }, []);

  // A page change mid-wait must not leave a capture armed for the next page.
  useEffect(
    () => () => {
      release.current?.();
    },
    [],
  );

  const bind = useCallback(
    async (type: TagType, value: string) => {
      setError(null);
      setMessage(null);
      try {
        const { tag, created } = await tagsApi.bind(item.id, type, value, unitId);
        setMessage(created ? `Bound ${type.toUpperCase()} ${tag.value}.` : `${tag.value} was already on this ${unitId ? "unit" : "item"}.`);
        await reload();
        onChange(await api.getItem(item.id));
      } catch (err) {
        setError(errorText(err, "Binding failed"));
      }
    },
    [item.id, unitId, reload, onChange],
  );

  const bindWithReader = useCallback(
    (type: TagType) => {
      stopWaiting();
      setError(null);
      setMessage(null);
      setWaiting({ how: "reader", type });
      armCapture((code) => {
        release.current = null;
        setWaiting(null);
        void bind(type, code);
      });
      release.current = () => armCapture(null);
    },
    [armCapture, bind, stopWaiting],
  );

  const bindWithTap = useCallback(async () => {
    if (!nfcSupported) return;
    stopWaiting();
    setError(null);
    setMessage(null);
    if (!(await nfc.start())) {
      setError(nfc.getState().error ?? "NFC could not start.");
      return;
    }
    setWaiting({ how: "tap", type: "nfc" });
    const pop = nfc.push((tap) => {
      pop();
      release.current = null;
      setWaiting(null);
      if (!tap.uid) {
        setError("That tag does not report an ID, so it cannot be bound. Write a link to it instead.");
        return;
      }
      void bind("nfc", tap.uid);
    });
    release.current = pop;
  }, [bind, stopWaiting]);

  return { waiting, message, error, bindWithReader, bindWithTap, cancel: stopWaiting, setError };
}

/** Changes whenever the item's identifiers or units do, to refetch its tags. */
export const identifiersKey = (item: ItemDetail) =>
  `${item.identifiers.map((i) => i.id).join(",")}|${item.units.map((u) => u.id).join(",")}`;
