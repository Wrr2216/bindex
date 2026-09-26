import { wireHandlingNotes } from "./handlingNotes";
import { wireJobEvents } from "./jobEvents";

/**
 * Connections between features that were built in parallel and could not
 * reference each other. Each is idempotent, so calling this twice is harmless.
 */
export function wireIntegrations(): void {
  wireJobEvents();
  wireHandlingNotes();
}
