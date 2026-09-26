import { tagKey } from "./normalize";

/**
 * The decisions behind a bulk binding session, kept free of the database so
 * they can be tested exhaustively.
 *
 * A session is a fixed list of items (or units) and a cursor. Each tag read
 * either binds to the entry under the cursor and moves it on, or is ignored:
 * a UHF reader reports the same tag many times a second, and tags already
 * bound anywhere must never move to another record.
 */

export type BindEntry = { itemId: string; unitId: string | null };

export type BindAction =
  | { kind: "bind"; index: number; value: string; identifierId: string; at: string }
  | { kind: "skip"; index: number; at: string };

export type BindState = { queue: BindEntry[]; position: number; history: BindAction[] };

export type IgnoreReason =
  /** Nothing readable in the read. */
  | "empty"
  /** Every entry has been bound or skipped. */
  | "finished"
  /** Already bound earlier in this session: the same tag read again. */
  | "repeat"
  /** Bound to something else before this session saw it. */
  | "in_use";

export type ReadDecision =
  | { kind: "bind"; index: number; entry: BindEntry }
  | { kind: "ignore"; reason: IgnoreReason };

/**
 * What to do with one read. `inUse` is whether the tag is already bound
 * anywhere, which only the database can answer.
 */
export function decideRead(state: BindState, raw: string, inUse: boolean): ReadDecision {
  const key = tagKey(raw);
  if (!key) return { kind: "ignore", reason: "empty" };
  if (state.history.some((a) => a.kind === "bind" && tagKey(a.value) === key)) {
    return { kind: "ignore", reason: "repeat" };
  }
  if (inUse) return { kind: "ignore", reason: "in_use" };
  if (state.position >= state.queue.length) return { kind: "ignore", reason: "finished" };
  return { kind: "bind", index: state.position, entry: state.queue[state.position]! };
}

export function applyBind(
  state: BindState,
  value: string,
  identifierId: string,
  at: string,
): BindState {
  return {
    ...state,
    position: state.position + 1,
    history: [...state.history, { kind: "bind", index: state.position, value, identifierId, at }],
  };
}

/** Leave the current entry untagged and move to the next one. */
export function applySkip(state: BindState, at: string): BindState {
  if (state.position >= state.queue.length) return state;
  return {
    ...state,
    position: state.position + 1,
    history: [...state.history, { kind: "skip", index: state.position, at }],
  };
}

/**
 * Take back the last bind or skip. The cursor returns to that entry, so the
 * next read binds it again. The caller deletes the identifier of an undone bind.
 */
export function applyUndo(state: BindState): { state: BindState; undone: BindAction | null } {
  const undone = state.history[state.history.length - 1] ?? null;
  if (!undone) return { state, undone: null };
  return {
    state: { ...state, position: undone.index, history: state.history.slice(0, -1) },
    undone,
  };
}

export function sessionCounts(state: BindState): { bound: number; skipped: number; remaining: number } {
  let bound = 0;
  let skipped = 0;
  for (const a of state.history) {
    if (a.kind === "bind") bound += 1;
    else skipped += 1;
  }
  return { bound, skipped, remaining: Math.max(0, state.queue.length - state.position) };
}
