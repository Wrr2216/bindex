/**
 * Scan feedback a crew can hear across a loading dock without looking at the
 * screen: a bright chirp for a good scan, a soft blip for one already done, and
 * a low double buzz for anything that needs a person. Web Audio only, so there
 * are no files to ship, and it stays silent where audio is unavailable.
 */

export type Cue = "ok" | "already" | "error";

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx ??= new Ctor();
    // Browsers start the context suspended until a gesture; the scan button
    // press that armed scanning counts, so resuming here works from then on.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(ac: AudioContext, freq: number, start: number, length: number, type: OscillatorType, volume: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ac.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + length);
  osc.connect(gain).connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + length + 0.02);
}

export function play(cue: Cue): void {
  const ac = context();
  if (!ac) return;
  if (cue === "ok") {
    tone(ac, 1320, 0, 0.09, "sine", 0.2);
  } else if (cue === "already") {
    tone(ac, 660, 0, 0.07, "sine", 0.08);
  } else {
    tone(ac, 180, 0, 0.18, "square", 0.12);
    tone(ac, 180, 0.24, 0.18, "square", 0.12);
  }
}

/** Unlock audio inside a click handler, so the first scan is not silent. */
export function primeAudio(): void {
  context();
}
