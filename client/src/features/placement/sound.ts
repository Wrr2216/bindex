/**
 * Sounds for a delivery crew who are carrying something and not looking at
 * the screen: a chirp when a label is fine, a soft blip for one already done,
 * and for a box that is on the wrong job or came off the wrong truck, an alarm
 * loud and long enough to stop someone walking off with it. Web Audio only,
 * silent where audio is unavailable.
 */

export type Cue = "ok" | "already" | "warn" | "alarm";

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx ??= new Ctor();
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
    tone(ac, 1760, 0.1, 0.09, "sine", 0.2);
  } else if (cue === "already") {
    tone(ac, 660, 0, 0.07, "sine", 0.08);
  } else if (cue === "warn") {
    tone(ac, 440, 0, 0.16, "triangle", 0.18);
  } else {
    // Two-tone siren, three times.
    for (let i = 0; i < 3; i++) {
      tone(ac, 880, i * 0.36, 0.16, "square", 0.22);
      tone(ac, 587, i * 0.36 + 0.18, 0.16, "square", 0.22);
    }
  }
}

/** Unlock audio inside a click handler, so the first scan is not silent. */
export function primeAudio(): void {
  context();
}
