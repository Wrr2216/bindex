/**
 * Duplicate suppression for sightings.
 *
 * A fixed reader reports a tag sitting in its field many times a second. What
 * is worth storing is "still here" at a sensible interval and anything that
 * changes (a new zone, a direction through a portal), not every read. The
 * window is measured from the last *stored* read, so a tag that stays in view
 * is stored once per window rather than once for as long as it stays.
 *
 * Held in memory, per process. After a restart the first read of each tag is
 * stored again, which is harmless.
 */
export class DuplicateFilter {
  private last = new Map<string, { at: number; sig: string }>();

  constructor(private readonly maxEntries = 200_000) {}

  /**
   * True when a read should be stored. `key` identifies the tag on a device;
   * `sig` is what makes a read different even inside the window (its zone and
   * direction). A read older than the reference one is stored when it falls
   * outside the window, but does not move the reference back in time.
   */
  admit(key: string, at: number, sig: string, windowMs: number): boolean {
    if (windowMs <= 0) return true;
    const prev = this.last.get(key);
    if (prev) {
      if (prev.sig === sig && Math.abs(at - prev.at) < windowMs) return false;
      if (at < prev.at) return true;
    }
    this.last.delete(key);
    this.last.set(key, { at, sig });
    if (this.last.size > this.maxEntries) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    return true;
  }

  /**
   * Undo an admit whose write failed, so a retry is not suppressed as a
   * duplicate of something that was never stored.
   */
  release(key: string, at: number): void {
    if (this.last.get(key)?.at === at) this.last.delete(key);
  }

  clear(): void {
    this.last.clear();
  }
}
