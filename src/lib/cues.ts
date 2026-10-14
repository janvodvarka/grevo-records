// Audible cues for the recording lifecycle. The screen is usually not the
// app while recording, so the countdown and the actual start have to be
// audible — otherwise there is no way to tell when capture began.
//
// Synthesised with WebAudio so there are no assets to ship or decode, and
// uses its own short-lived AudioContext so it can never be confused with the
// recording's audio graph.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One short tone. Gain is ramped, a hard start/stop would click. */
function tone(freq: number, durationMs: number, gain = 0.12, delayMs = 0) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + delayMs / 1000;
  const dur = durationMs / 1000;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  vol.gain.setValueAtTime(0.0001, t0);
  vol.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(vol).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Countdown tick (3… 2… 1…) — low and short. */
export function cueCountdown() {
  tone(660, 110);
}

/** Capture is live. Deliberately higher and longer than the ticks. */
export function cueStart() {
  tone(990, 260, 0.14);
}

/** Capture stopped — two descending notes, unmistakably not a start. */
export function cueStop() {
  tone(760, 130, 0.12, 0);
  tone(500, 190, 0.12, 140);
}
