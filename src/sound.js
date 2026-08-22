// Sound: every effect and the background music are synthesized live via the
// Web Audio API. There are no audio files anywhere in this project -- see
// the "sound" section of src/config.js for why (zero runtime dependencies,
// and the natural reference project's own sound assets are licensed/
// proprietary in ways this project's established precedent says not to
// import literally, only to study the shape of).
//
// Architecture, so the reasoning behind the shape below doesn't need to be
// re-derived later:
//   1. src/game.js only emits facts (Game#signal), never plays anything or
//      knows what a "player-relevant" event is -- that decision lives here,
//      entirely, so it's testable in one place and the simulation module
//      stays DOM-free (tools/simulate.js and every headless test import it
//      undecorated).
//   2. Every synthesis recipe is a pure function of (ctx, out, t0, sources)
//      -- it never reads instance state. That is what makes a recipe
//      testable by rendering it into an OfflineAudioContext and inspecting
//      the resulting samples, the only substitute for a listen-through
//      available in this environment.
//   3. The generative music layer pulls from Math.random(), never a match's
//      seeded rng -- consuming the seeded stream would break "Restart
//      Match" reproducing the same world. This is the one genuinely
//      dangerous mistake available in this feature; do not "fix" it.

import {
  SFX_VOLUME_DEFAULT,
  MUSIC_VOLUME_DEFAULT,
  MAX_SFX_VOICES,
  SFX_MIN_GAP_MS,
  SFX_GAP_MS,
  SFX_MIX,
  MUSIC_CHORDS,
  MUSIC_TRANSITIONS,
  MUSIC_CHORD_SECONDS,
  MUSIC_BELL_SECONDS,
  MUSIC_CROSSFADE,
  MUSIC_FADE_IN,
  MUSIC_FADE_OUT,
  MUSIC_FILTER_LFO_HZ,
  MUSIC_DUCK_TO,
} from './config.js';

const PAD_PEAK = 0.11;

// ------------------------------------------------------- shared helpers ----

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Perceived loudness is roughly logarithmic but a slider position is
 *  linear, so the top of the range would otherwise sound identical to the
 *  middle. Square it for an audio-taper curve. */
function taper(position) {
  const c = clamp01(position);
  return c * c;
}

let noiseBufferCache = null;
/** One shared 2s white-noise buffer, built lazily and reused by every
 *  recipe that wants noise -- building a fresh buffer per sound effect
 *  would be wasteful for something this short-lived. */
function getNoiseBuffer(ctx) {
  if (!noiseBufferCache || noiseBufferCache.ctx !== ctx) {
    const len = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noiseBufferCache = { ctx, buffer };
  }
  return noiseBufferCache.buffer;
}

function noiseSource(ctx) {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  src.loop = true; // the buffer is 2s, longer than any single effect needs
  return src;
}

function makeOsc(ctx, type, freq, detune = 0) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  if (detune) osc.detune.value = detune;
  return osc;
}

function makeFilter(ctx, type, freq, Q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q;
  return f;
}

/**
 * Shapes an attack/hold/decay envelope onto an AudioParam starting at t0.
 * `exponentialRampToValueAtTime` throws on a target of exactly 0 and does
 * nothing useful starting from 0, so every envelope parks at a small floor
 * first, ramps up linearly (a linear attack reads as punchier than
 * exponential for a short transient), then decays exponentially (which
 * matches how ears actually perceive loudness falling off) down to that
 * same floor, and only then snaps to true 0. Returns the total duration
 * from t0, in seconds.
 */
function envelope(param, t0, { peak, attack = 0.01, hold = 0, decay, floor = 0.0001 }) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(floor, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  const holdEnd = t0 + attack + hold;
  if (hold > 0) param.setValueAtTime(peak, holdEnd);
  const decayEnd = holdEnd + decay;
  param.exponentialRampToValueAtTime(floor, decayEnd);
  param.setValueAtTime(0, decayEnd + 0.02);
  return decayEnd + 0.02 - t0;
}

function sweepExp(param, t0, from, to, dur) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(Math.max(from, 0.0001), t0);
  param.exponentialRampToValueAtTime(Math.max(to, 0.0001), t0 + dur);
}

function sweepLin(param, t0, from, to, dur) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(from, t0);
  param.linearRampToValueAtTime(to, t0 + dur);
}

/** Weighted random pick from a {key: weight} map whose weights sum to ~1. */
function weightedPick(weights) {
  const r = Math.random();
  let acc = 0;
  for (const [key, w] of Object.entries(weights)) {
    acc += w;
    if (r < acc) return key;
  }
  return Object.keys(weights)[0]; // float rounding fallback
}

// ---------------------------------------------------------- sfx recipes ----
//
// Each recipe is `(ctx, out, t0, sources) => durationSeconds`. `sources` is
// an array the recipe pushes every start()-able node into, so the voice
// pool can fade/stop them together on eviction. Every recipe is self-
// contained -- it builds its own little node graph and connects it to
// `out`, never touching instance state. Tonal effects draw only from an
// A-minor pitch pool shared with the music (§ config.js MUSIC_CHORDS) so
// nothing ever clashes with the background music.

const RECIPES = {
  click(ctx, out, t0, sources) {
    const osc = makeOsc(ctx, 'square', 1200);
    const hp = makeFilter(ctx, 'highpass', 500, 0.7);
    const g = ctx.createGain();
    osc.connect(hp);
    hp.connect(g);
    g.connect(out);
    sweepExp(osc.frequency, t0, 1200, 620, 0.02);
    const dur = envelope(g.gain, t0, { peak: 0.16, attack: 0.002, decay: 0.033 });
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    sources.push(osc);

    const noise = noiseSource(ctx);
    const bp = makeFilter(ctx, 'bandpass', 2400, 1.2);
    const ng = ctx.createGain();
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    envelope(ng.gain, t0, { peak: 0.05, attack: 0.002, decay: 0.016 });
    noise.start(t0);
    noise.stop(t0 + 0.02);
    sources.push(noise);

    return dur;
  },

  'build-city'(ctx, out, t0, sources) {
    // A short marimba-like pair -- a fifth apart -- for the warmest,
    // simplest of the five builds.
    for (const [delay, freq] of [[0, 220], [0.09, 329.63]]) {
      const osc = makeOsc(ctx, 'triangle', freq);
      const lp = makeFilter(ctx, 'lowpass', 1800, 0.7);
      const g = ctx.createGain();
      osc.connect(lp);
      lp.connect(g);
      g.connect(out);
      const start = t0 + delay;
      envelope(g.gain, start, { peak: 0.22, attack: 0.004, decay: 0.28 });
      osc.start(start);
      osc.stop(start + 0.32);
      sources.push(osc);
    }
    const noise = noiseSource(ctx);
    const bp = makeFilter(ctx, 'bandpass', 900, 2);
    const ng = ctx.createGain();
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    envelope(ng.gain, t0, { peak: 0.06, attack: 0.002, decay: 0.023 });
    noise.start(t0);
    noise.stop(t0 + 0.03);
    sources.push(noise);
    return 0.4;
  },

  'build-port'(ctx, out, t0, sources) {
    // A wave lapping the new dock -- filtered noise sweeping up then
    // settling, plus a slow detuned "buoy beat" pair of sines.
    const noise = noiseSource(ctx);
    const lp = makeFilter(ctx, 'lowpass', 300, 0.8);
    const ng = ctx.createGain();
    noise.connect(lp);
    lp.connect(ng);
    ng.connect(out);
    lp.frequency.cancelScheduledValues(t0);
    lp.frequency.setValueAtTime(300, t0);
    lp.frequency.linearRampToValueAtTime(2600, t0 + 0.16);
    lp.frequency.exponentialRampToValueAtTime(400, t0 + 0.5);
    envelope(ng.gain, t0, { peak: 0.13, attack: 0.05, decay: 0.42 });
    noise.start(t0);
    noise.stop(t0 + 0.55);
    sources.push(noise);

    for (const freq of [146.83, 147.6]) {
      const osc = makeOsc(ctx, 'sine', freq);
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(out);
      sweepLin(osc.frequency, t0, freq, freq * 1.12, 0.3);
      envelope(g.gain, t0, { peak: 0.07, attack: 0.04, decay: 0.42 });
      osc.start(t0);
      osc.stop(t0 + 0.55);
      sources.push(osc);
    }
    return 0.55;
  },

  'build-defense'(ctx, out, t0, sources) {
    // A metal clang -- inharmonic partials, since inharmonicity is what
    // reads as metal rather than a tuned note.
    for (const [freq, peak, decay] of [[320, 0.09, 0.45], [451, 0.09, 0.3], [682, 0.09, 0.22]]) {
      const osc = makeOsc(ctx, 'square', freq);
      const bp = makeFilter(ctx, 'bandpass', 1100, 0.9);
      const hp = makeFilter(ctx, 'highpass', 250, 0.7);
      const g = ctx.createGain();
      osc.connect(bp);
      bp.connect(hp);
      hp.connect(g);
      g.connect(out);
      envelope(g.gain, t0, { peak, attack: 0.003, decay });
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
      sources.push(osc);
    }
    const noise = noiseSource(ctx);
    const hp2 = makeFilter(ctx, 'highpass', 3000, 0.7);
    const ng = ctx.createGain();
    noise.connect(hp2);
    hp2.connect(ng);
    ng.connect(out);
    envelope(ng.gain, t0, { peak: 0.1, attack: 0.001, decay: 0.011 });
    noise.start(t0);
    noise.stop(t0 + 0.02);
    sources.push(noise);
    return 0.45;
  },

  'build-silo'(ctx, out, t0, sources) {
    // A hydraulic door: a resonant sweeping lowpass on a falling sawtooth,
    // ending in a terminal clunk. The heaviest of the five builds.
    const osc = makeOsc(ctx, 'sawtooth', 110);
    const lp = makeFilter(ctx, 'lowpass', 900, 3);
    const g = ctx.createGain();
    osc.connect(lp);
    lp.connect(g);
    g.connect(out);
    sweepExp(osc.frequency, t0, 110, 55, 0.35);
    sweepLin(lp.frequency, t0, 900, 180, 0.4);
    envelope(g.gain, t0, { peak: 0.18, attack: 0.03, hold: 0.25, decay: 0.22 });
    osc.start(t0);
    osc.stop(t0 + 0.55);
    sources.push(osc);

    const clunkT = t0 + 0.42;
    const noise = noiseSource(ctx);
    const clunkLp = makeFilter(ctx, 'lowpass', 400, 1);
    const ng = ctx.createGain();
    noise.connect(clunkLp);
    clunkLp.connect(ng);
    ng.connect(out);
    envelope(ng.gain, clunkT, { peak: 0.12, attack: 0.004, decay: 0.086 });
    noise.start(clunkT);
    noise.stop(clunkT + 0.1);
    sources.push(noise);
    return 0.55;
  },

  'build-sam'(ctx, out, t0, sources) {
    // A radar power-up -- two rising chirps, unmistakably electronic.
    for (const [delay, from, to] of [[0, 660, 1320], [0.11, 880, 1760]]) {
      const osc = makeOsc(ctx, 'sine', from);
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(out);
      const start = t0 + delay;
      sweepExp(osc.frequency, start, from, to, 0.07);
      envelope(g.gain, start, { peak: 0.13, attack: 0.005, decay: 0.07 });
      osc.start(start);
      osc.stop(start + 0.1);
      sources.push(osc);
    }
    const sub = makeOsc(ctx, 'sine', 82.4);
    const sg = ctx.createGain();
    sub.connect(sg);
    sg.connect(out);
    envelope(sg.gain, t0, { peak: 0.05, attack: 0.01, decay: 0.24 });
    sub.start(t0);
    sub.stop(t0 + 0.3);
    sources.push(sub);
    return 0.3;
  },

  'nuke-launch'(ctx, out, t0, sources) {
    // Ignition + thrust + a doppler climb. Global -- never owner-gated.
    const noise = noiseSource(ctx);
    const bp = makeFilter(ctx, 'bandpass', 200, 1.4);
    const ng = ctx.createGain();
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    sweepLin(bp.frequency, t0, 200, 1400, 0.9);
    envelope(ng.gain, t0, { peak: 0.3, attack: 0.18, hold: 0.52, decay: 0.7 });
    noise.start(t0);
    noise.stop(t0 + 1.42);
    sources.push(noise);

    const lp = makeFilter(ctx, 'lowpass', 420, 0.7);
    const tg = ctx.createGain();
    lp.connect(tg);
    tg.connect(out);
    envelope(tg.gain, t0, { peak: 0.12, attack: 0.05, hold: 0.9, decay: 0.4 });
    for (const freq of [68, 71]) {
      const osc = makeOsc(ctx, 'sawtooth', freq);
      osc.connect(lp);
      osc.start(t0);
      osc.stop(t0 + 1.42);
      sources.push(osc);
    }

    const dop = makeOsc(ctx, 'triangle', 180);
    const dg = ctx.createGain();
    dop.connect(dg);
    dg.connect(out);
    sweepExp(dop.frequency, t0, 180, 760, 1.1);
    dg.gain.setValueAtTime(0.0001, t0);
    dg.gain.linearRampToValueAtTime(0.1, t0 + 0.4);
    dg.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.3);
    dop.start(t0);
    dop.stop(t0 + 1.35);
    sources.push(dop);
    return 1.4;
  },

  'nuke-hit'(ctx, out, t0, sources) {
    // The loudest thing in the game -- crack, boom, sub thump, and a
    // delayed echo tail across the map. Global.
    const crack = noiseSource(ctx);
    const chp = makeFilter(ctx, 'highpass', 1200, 0.7);
    const cg = ctx.createGain();
    crack.connect(chp);
    chp.connect(cg);
    cg.connect(out);
    envelope(cg.gain, t0, { peak: 0.35, attack: 0.004, decay: 0.216 });
    crack.start(t0);
    crack.stop(t0 + 0.25);
    sources.push(crack);

    const boom = noiseSource(ctx);
    const blp = makeFilter(ctx, 'lowpass', 900, 0.7);
    const bg = ctx.createGain();
    boom.connect(blp);
    blp.connect(bg);
    bg.connect(out);
    sweepLin(blp.frequency, t0, 900, 90, 1.8);
    envelope(bg.gain, t0, { peak: 0.4, attack: 0.02, decay: 1.88 });
    boom.start(t0);
    boom.stop(t0 + 1.95);
    sources.push(boom);

    const sub = makeOsc(ctx, 'sine', 90);
    const sg = ctx.createGain();
    sub.connect(sg);
    sg.connect(out);
    sweepExp(sub.frequency, t0, 90, 28, 0.9);
    envelope(sg.gain, t0, { peak: 0.32, attack: 0.01, decay: 0.89 });
    sub.start(t0);
    sub.stop(t0 + 0.95);
    sources.push(sub);

    // A short local delay for the "echo across the map" tail -- this
    // effect's own bus, not the shared music delay.
    const tailT = t0 + 0.25;
    const tail = noiseSource(ctx);
    const tlp = makeFilter(ctx, 'lowpass', 200, 0.7);
    const tg = ctx.createGain();
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.18;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    tail.connect(tlp);
    tlp.connect(tg);
    tg.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(out);
    envelope(tg.gain, tailT, { peak: 0.1, attack: 0.02, decay: 1.93 });
    tail.start(tailT);
    tail.stop(tailT + 2);
    sources.push(tail);
    return 2.2;
  },

  intercept(ctx, out, t0, sources) {
    // A bright zip + pop -- clearly not the big boom.
    const zip = makeOsc(ctx, 'sawtooth', 1800);
    const bp = makeFilter(ctx, 'bandpass', 1500, 2);
    const zg = ctx.createGain();
    zip.connect(bp);
    bp.connect(zg);
    zg.connect(out);
    sweepExp(zip.frequency, t0, 1800, 300, 0.12);
    envelope(zg.gain, t0, { peak: 0.18, attack: 0.003, decay: 0.117 });
    zip.start(t0);
    zip.stop(t0 + 0.15);
    sources.push(zip);

    const popT = t0 + 0.12;
    const pop = noiseSource(ctx);
    const pbp = makeFilter(ctx, 'bandpass', 700, 1.5);
    const pg = ctx.createGain();
    pop.connect(pbp);
    pbp.connect(pg);
    pg.connect(out);
    envelope(pg.gain, popT, { peak: 0.22, attack: 0.003, decay: 0.117 });
    pop.start(popT);
    pop.stop(popT + 0.15);
    sources.push(pop);

    const sparkT = t0 + 0.06;
    const spark = makeOsc(ctx, 'triangle', 1320);
    const sg = ctx.createGain();
    spark.connect(sg);
    sg.connect(out);
    envelope(sg.gain, sparkT, { peak: 0.06, attack: 0.005, decay: 0.175 });
    spark.start(sparkT);
    spark.stop(sparkT + 0.19);
    sources.push(spark);
    return 0.35;
  },

  conquest(ctx, out, t0, sources) {
    // The payoff -- a rising bell arpeggio through a short shimmer delay.
    const delay = ctx.createDelay(0.3);
    delay.delayTime.value = 0.11;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    delay.connect(fb);
    fb.connect(delay);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    delay.connect(wet);
    wet.connect(out);

    const notes = [[440, 0], [523.25, 0.07], [659.25, 0.14], [880, 0.24]];
    const decays = [0.9, 0.8, 0.7, 1.1];
    notes.forEach(([freq, delayT], i) => {
      const start = t0 + delayT;
      const decay = decays[i];
      const fund = makeOsc(ctx, 'sine', freq);
      const fg = ctx.createGain();
      fund.connect(fg);
      fg.connect(out);
      fg.connect(delay);
      envelope(fg.gain, start, { peak: 0.14, attack: 0.003, decay });
      fund.start(start);
      fund.stop(start + decay + 0.1);
      sources.push(fund);

      const harm = makeOsc(ctx, 'triangle', freq * 2);
      const hg = ctx.createGain();
      harm.connect(hg);
      hg.connect(out);
      envelope(hg.gain, start, { peak: 0.05, attack: 0.003, decay: decay * 0.7 });
      harm.start(start);
      harm.stop(start + decay + 0.1);
      sources.push(harm);
    });

    const chipT = t0 + 0.24;
    const chip = noiseSource(ctx);
    const bp = makeFilter(ctx, 'bandpass', 5200, 3);
    const cg = ctx.createGain();
    chip.connect(bp);
    bp.connect(cg);
    cg.connect(out);
    envelope(cg.gain, chipT, { peak: 0.06, attack: 0.002, decay: 0.038 });
    chip.start(chipT);
    chip.stop(chipT + 0.05);
    sources.push(chip);
    return 1.2;
  },

  annex(ctx, out, t0, sources) {
    // Same reward family as conquest, but heavier and darker so the two
    // are distinguishable eyes-closed -- a "closing in" wash underneath.
    const lp = makeFilter(ctx, 'lowpass', 2200, 0.8);
    lp.connect(out);
    const notes = [[329.63, 0, 0.5, false], [293.66, 0.1, 0.45, false], [220, 0.2, 1.4, true]];
    for (const [freq, delayT, decay, withSub] of notes) {
      const start = t0 + delayT;
      const fund = makeOsc(ctx, 'triangle', freq);
      const fg = ctx.createGain();
      fund.connect(fg);
      fg.connect(lp);
      envelope(fg.gain, start, { peak: 0.13, attack: 0.004, decay });
      fund.start(start);
      fund.stop(start + decay + 0.1);
      sources.push(fund);
      if (withSub) {
        const sub = makeOsc(ctx, 'sine', freq * 0.5);
        const sg = ctx.createGain();
        sub.connect(sg);
        sg.connect(lp);
        envelope(sg.gain, start, { peak: 0.07, attack: 0.01, decay });
        sub.start(start);
        sub.stop(start + decay + 0.1);
        sources.push(sub);
      }
    }
    const wash = noiseSource(ctx);
    const wlp = makeFilter(ctx, 'lowpass', 700, 0.8);
    const wg = ctx.createGain();
    wash.connect(wlp);
    wlp.connect(wg);
    wg.connect(out);
    envelope(wg.gain, t0, { peak: 0.07, attack: 0.3, decay: 0.7 });
    wash.start(t0);
    wash.stop(t0 + 1.1);
    sources.push(wash);
    return 1.5;
  },

  'alliance-offer'(ctx, out, t0, sources) {
    // An unresolved rising question -- a fifth up, with vibrato on the
    // second note, and a faint third note left hanging.
    const first = makeOsc(ctx, 'sine', 392);
    const fg = ctx.createGain();
    first.connect(fg);
    fg.connect(out);
    envelope(fg.gain, t0, { peak: 0.12, attack: 0.02, decay: 0.2 });
    first.start(t0);
    first.stop(t0 + 0.24);
    sources.push(first);

    const secondT = t0 + 0.22;
    const second = makeOsc(ctx, 'sine', 587.33);
    const sg = ctx.createGain();
    const lfo = makeOsc(ctx, 'sine', 5.5);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 4;
    lfo.connect(lfoGain);
    lfoGain.connect(second.detune);
    second.connect(sg);
    sg.connect(out);
    envelope(sg.gain, secondT, { peak: 0.12, attack: 0.02, decay: 0.48 });
    second.start(secondT);
    second.stop(secondT + 0.52);
    lfo.start(secondT);
    lfo.stop(secondT + 0.52);
    sources.push(second, lfo);

    const thirdT = t0 + 0.34;
    const third = makeOsc(ctx, 'sine', 880);
    const tg = ctx.createGain();
    third.connect(tg);
    tg.connect(out);
    envelope(tg.gain, thirdT, { peak: 0.04, attack: 0.03, decay: 0.4 });
    third.start(thirdT);
    third.stop(thirdT + 0.44);
    sources.push(third);
    return 0.8;
  },

  'alliance-formed'(ctx, out, t0, sources) {
    // The handshake -- the only true major chord in the whole set, so it
    // reads unambiguously as good news.
    const lp = makeFilter(ctx, 'lowpass', 600, 0.9);
    lp.connect(out);
    sweepLin(lp.frequency, t0, 600, 2400, 0.4);
    for (const freq of [220, 277.18, 329.63]) {
      const osc = makeOsc(ctx, 'sine', freq);
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(lp);
      envelope(g.gain, t0, { peak: 0.1, attack: 0.03, decay: 1.1 });
      osc.start(t0);
      osc.stop(t0 + 1.2);
      sources.push(osc);
    }
    const bright = makeOsc(ctx, 'triangle', 440);
    const bg = ctx.createGain();
    bright.connect(bg);
    bg.connect(lp);
    envelope(bg.gain, t0, { peak: 0.05, attack: 0.03, decay: 1.0 });
    bright.start(t0);
    bright.stop(t0 + 1.1);
    sources.push(bright);
    return 1.2;
  },

  'alliance-broken'(ctx, out, t0, sources) {
    // An amicable split -- an open, hollow fifth (no third) that audibly
    // sours apart as it fades, no percussion at all.
    const lp = makeFilter(ctx, 'lowpass', 2000, 0.8);
    lp.connect(out);
    sweepLin(lp.frequency, t0, 2000, 500, 1.0);
    const pairs = [[220, -35], [329.63, 35]];
    for (const [freq, detuneTo] of pairs) {
      const osc = makeOsc(ctx, 'sine', freq);
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(lp);
      osc.detune.setValueAtTime(0, t0);
      osc.detune.linearRampToValueAtTime(detuneTo, t0 + 0.9);
      envelope(g.gain, t0, { peak: 0.09, attack: 0.04, decay: 1.0 });
      osc.start(t0);
      osc.stop(t0 + 1.1);
      sources.push(osc);
    }
    return 1.1;
  },

  betrayed(ctx, out, t0, sources) {
    // The nastiest sound in the game -- a dissonant minor-second stab with
    // tremolo, a falling drop, and a little grit.
    const lp = makeFilter(ctx, 'lowpass', 1600, 0.9);
    lp.connect(out);
    for (const freq of [233.08, 246.94]) {
      const osc = makeOsc(ctx, 'sawtooth', freq);
      const g = ctx.createGain();
      const trem = makeOsc(ctx, 'sine', 7);
      const tremGain = ctx.createGain();
      tremGain.gain.value = 0.35;
      trem.connect(tremGain);
      tremGain.connect(g.gain);
      osc.connect(g);
      g.connect(lp);
      envelope(g.gain, t0, { peak: 0.12, attack: 0.005, decay: 0.9 });
      osc.start(t0);
      osc.stop(t0 + 1.0);
      trem.start(t0);
      trem.stop(t0 + 1.0);
      sources.push(osc, trem);
    }

    const drop = makeOsc(ctx, 'sine', 174.61);
    const dg = ctx.createGain();
    drop.connect(dg);
    dg.connect(out);
    sweepExp(drop.frequency, t0, 174.61, 87.31, 0.7);
    envelope(dg.gain, t0, { peak: 0.16, attack: 0.02, decay: 0.68 });
    drop.start(t0);
    drop.stop(t0 + 0.75);
    sources.push(drop);

    const grit = noiseSource(ctx);
    const bp = makeFilter(ctx, 'bandpass', 1800, 0.8);
    const gg = ctx.createGain();
    grit.connect(bp);
    bp.connect(gg);
    gg.connect(out);
    envelope(gg.gain, t0, { peak: 0.07, attack: 0.01, decay: 0.34 });
    grit.start(t0);
    grit.stop(t0 + 0.38);
    sources.push(grit);
    return 1.3;
  },

  victory(ctx, out, t0, sources) {
    const delay = ctx.createDelay(0.3);
    delay.delayTime.value = 0.11;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    delay.connect(fb);
    fb.connect(delay);
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    delay.connect(wet);
    wet.connect(out);

    const notes = [[220, 0, 0.4], [277.18, 0.18, 0.4], [329.63, 0.36, 0.4], [440, 0.54, 1.2]];
    for (const [freq, delayT, decay] of notes) {
      const start = t0 + delayT;
      const fund = makeOsc(ctx, 'triangle', freq);
      const fg = ctx.createGain();
      fund.connect(fg);
      fg.connect(out);
      fg.connect(delay);
      envelope(fg.gain, start, { peak: 0.14, attack: 0.005, decay });
      fund.start(start);
      fund.stop(start + decay + 0.1);
      sources.push(fund);

      const harm = makeOsc(ctx, 'sine', freq * 2);
      const hg = ctx.createGain();
      harm.connect(hg);
      hg.connect(out);
      envelope(hg.gain, start, { peak: 0.05, attack: 0.005, decay: decay * 0.7 });
      harm.start(start);
      harm.stop(start + decay + 0.1);
      sources.push(harm);
    }
    return 1.8;
  },

  defeat(ctx, out, t0, sources) {
    const lp = makeFilter(ctx, 'lowpass', 1500, 0.8);
    lp.connect(out);
    sweepLin(lp.frequency, t0, 1500, 300, 2.0);
    const notes = [[220, 0, 0.4], [196, 0.22, 0.4], [174.61, 0.44, 0.4], [130.81, 0.66, 1.6]];
    for (const [freq, delayT, decay] of notes) {
      const start = t0 + delayT;
      const osc = makeOsc(ctx, 'sine', freq);
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(lp);
      envelope(g.gain, start, { peak: 0.13, attack: 0.02, decay });
      osc.start(start);
      osc.stop(start + decay + 0.1);
      sources.push(osc);
    }
    const sub = makeOsc(ctx, 'sine', 65.4);
    const sg = ctx.createGain();
    sub.connect(sg);
    sg.connect(out);
    envelope(sg.gain, t0 + 0.66, { peak: 0.06, attack: 0.05, decay: 1.5 });
    sub.start(t0 + 0.66);
    sub.stop(t0 + 2.3);
    sources.push(sub);
    return 2.2;
  },
};

// -------------------------------------------------------------------------

export class SoundBoard {
  constructor({ sfxVolume = SFX_VOLUME_DEFAULT, musicVolume = MUSIC_VOLUME_DEFAULT, muted = false } = {}) {
    this.ctx = null;
    this._sfxVolume = clamp01(sfxVolume);
    this._musicVolume = clamp01(musicVolume);
    this._muted = !!muted;
    this.game = null;

    /** Set false in tests to burst past the rate limit deliberately. */
    this.rateLimit = true;

    this._voices = []; // { name, endsAt, gain, sources }
    this._lastAt = new Map(); // name -> ctx.currentTime of last successful play
    this._playCounts = new Map();
    this.lastPlayed = null; // { name, at } | null

    this._musicPlaying = false;
    this._musicNodes = null;
    this._chordTimer = null;
    this._bellTimer = null;
    this._currentChord = 'i';
    this._activePad = 0;
  }

  get available() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
  }
  get running() {
    return this.ctx?.state === 'running';
  }
  get sfxVolume() {
    return this._sfxVolume;
  }
  get musicVolume() {
    return this._musicVolume;
  }
  get muted() {
    return this._muted;
  }
  get musicPlaying() {
    return this._musicPlaying;
  }
  get activeVoices() {
    return this._voices.length;
  }
  get musicVoiceCount() {
    if (!this._musicNodes) return 0;
    const pads = this._musicNodes.pads.reduce((s, p) => s + p.oscs.length, 0);
    return this._musicNodes.drone.length + 1 /* lfo */ + pads;
  }

  /** Must be called synchronously from inside a real user gesture -- that
   *  is what actually satisfies the browser autoplay policy. Idempotent:
   *  a second call just resumes an already-built context. */
  unlock() {
    if (this.ctx) {
      this.ctx.resume().catch(() => {});
      return;
    }
    if (!this.available) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.#buildGraph();
    this.#applyVolumes(0);
    this.ctx.resume().catch(() => {});
  }

  #buildGraph() {
    const ctx = this.ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this._muted ? 0 : 1;
    this.masterGain.connect(ctx.destination);

    this.sfxGain = ctx.createGain();
    this.sfxGain.connect(this.masterGain);

    this.musicGain = ctx.createGain();
    this.musicGain.connect(this.masterGain);

    // Shared feedback delay bus for the pads + bell (music only; the drone
    // stays dry so the low end doesn't get muddy).
    this.musicDelay = ctx.createDelay(1.0);
    this.musicDelay.delayTime.value = 0.42;
    const feedbackFilter = makeFilter(ctx, 'lowpass', 2000, 0.7);
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    this.musicDelay.connect(feedbackFilter);
    feedbackFilter.connect(feedback);
    feedback.connect(this.musicDelay);
    const delayOut = ctx.createGain();
    delayOut.gain.value = 0.35;
    this.musicDelay.connect(delayOut);
    delayOut.connect(this.musicGain);
  }

  #applyVolumes(rampSec = 0.02) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const sfxTarget = taper(this._sfxVolume);
    const musicTarget = taper(this._musicVolume);
    const masterTarget = this._muted ? 0 : 1;
    for (const [param, target] of [
      [this.sfxGain.gain, sfxTarget],
      [this.musicGain.gain, musicTarget],
      [this.masterGain.gain, masterTarget],
    ]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(target, now + rampSec);
    }
  }

  setSfxVolume(v) {
    this._sfxVolume = clamp01(v);
    this.#applyVolumes();
  }

  setMusicVolume(v) {
    const was = this._musicVolume;
    this._musicVolume = clamp01(v);
    this.#applyVolumes();
    if (this._musicVolume === 0 && was > 0 && this._musicPlaying) this.stopMusic();
    else if (this._musicVolume > 0 && was === 0 && !this._musicPlaying && this.game) this.startMusic();
  }

  setMuted(on) {
    this._muted = !!on;
    this.#applyVolumes();
  }

  toggleMute() {
    this.setMuted(!this._muted);
  }

  suspend() {
    this.ctx?.suspend().catch(() => {});
  }
  resume() {
    this.ctx?.resume().catch(() => {});
  }

  bind(game) {
    this.game = game;
    game.onEvent = (type, data) => this.#onGameEvent(type, data);
  }

  unbind() {
    if (this.game) this.game.onEvent = null;
    this.game = null;
    this.stopMusic();
  }

  #onGameEvent(type, data) {
    const me = this.game?.human?.id;
    if (me === undefined || me === null) return;
    switch (type) {
      case 'build':
        if (data.playerId === me) this.play(`build-${data.key}`);
        break;
      case 'nuke-launch':
        this.play('nuke-launch'); // global -- everyone hears a launch
        break;
      case 'nuke-hit':
        this.play('nuke-hit'); // global
        this.#duck();
        break;
      case 'intercept':
        this.play('intercept'); // global
        break;
      case 'eliminated':
        // killerId is -1 for a nuke-kill (land reverts to NEUTRAL, nobody
        // was standing there to conquer it) -- never equals a real id, so
        // this silently and correctly declines the reward sound for it.
        if (data.killerId === me) {
          this.play('conquest');
          this.#duck(0.6, 0.05, 1.0);
        }
        break;
      case 'annexed':
        if (data.conquerorId === me) {
          this.play('annex');
          this.#duck(0.6, 0.05, 1.0);
        }
        break;
      case 'alliance-offer':
        this.play('alliance-offer');
        break;
      case 'alliance-formed':
        if (data.aId === me || data.bId === me) this.play('alliance-formed');
        break;
      case 'alliance-broken':
        if (data.initiatorId === me || data.otherId === me) this.play('alliance-broken');
        break;
      case 'betrayed':
        if (data.initiatorId === me || data.otherId === me) this.play('betrayed');
        break;
      default:
        break;
    }
  }

  #duck(to = MUSIC_DUCK_TO, holdSec = 0.3, recoverSec = 1.2) {
    if (!this.ctx || !this._musicPlaying) return;
    const now = this.ctx.currentTime;
    const downSec = 0.1;
    const base = taper(this._musicVolume);
    const duckTarget = Math.max(base * to, 0.0001);
    const g = this.musicGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(duckTarget, now + downSec);
    g.setValueAtTime(duckTarget, now + downSec + holdSec);
    g.linearRampToValueAtTime(Math.max(base, 0.0001), now + downSec + holdSec + recoverSec);
  }

  // ---------------------------------------------------------------- sfx ----

  play(name) {
    if (!this.ctx || this._muted || this._sfxVolume === 0) return false;
    if (!RECIPES[name]) return false;

    const now = this.ctx.currentTime;
    this.#reapVoices(now);

    if (this.rateLimit) {
      const gap = (SFX_GAP_MS[name] ?? SFX_MIN_GAP_MS) / 1000;
      const last = this._lastAt.get(name);
      if (last !== undefined && now - last < gap) return false;
    }

    if (this._voices.length >= MAX_SFX_VOICES) {
      const oldest = this._voices.shift();
      this.#fadeOutVoice(oldest, now);
    }

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = SFX_MIX[name] ?? 1;
    voiceGain.connect(this.sfxGain);

    const sources = [];
    const t0 = now + 0.005;
    const dur = RECIPES[name](this.ctx, voiceGain, t0, sources);
    this._voices.push({ name, endsAt: t0 + dur, gain: voiceGain, sources });

    this._lastAt.set(name, now);
    this._playCounts.set(name, (this._playCounts.get(name) || 0) + 1);
    this.lastPlayed = { name, at: now };
    return true;
  }

  playCountOf(name) {
    return this._playCounts.get(name) || 0;
  }

  resetCounts() {
    this._playCounts.clear();
    this.lastPlayed = null;
  }

  #reapVoices(now) {
    this._voices = this._voices.filter((v) => {
      if (v.endsAt > now) return true;
      for (const s of v.sources) {
        try {
          s.disconnect();
        } catch {
          /* already gone */
        }
      }
      try {
        v.gain.disconnect();
      } catch {
        /* already gone */
      }
      return false;
    });
  }

  #fadeOutVoice(voice, now) {
    const g = voice.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, 0.0001), now);
    g.exponentialRampToValueAtTime(0.0001, now + 0.03);
    for (const s of voice.sources) {
      try {
        s.stop(now + 0.035);
      } catch {
        /* may already be scheduled to stop, or already stopped */
      }
    }
  }

  /** Renders one recipe into an OfflineAudioContext and returns simple
   *  sample-level stats -- the closest thing to a listen-through available
   *  in a headless test. */
  async renderOffline(name, seconds) {
    const recipe = RECIPES[name];
    if (!recipe) return null;
    const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtor) return null;
    const sampleRate = 44100;
    const offlineCtx = new OfflineCtor(1, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
    const out = offlineCtx.createGain();
    out.gain.value = 1;
    out.connect(offlineCtx.destination);
    recipe(offlineCtx, out, 0.01, []);
    const buffer = await offlineCtx.startRendering();
    const data = buffer.getChannelData(0);

    let peak = 0;
    let sumSquares = 0;
    let brightnessAccum = 0;
    let prev = 0;
    const tailStart = Math.floor(data.length * 0.9);
    let tailSumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      const abs = Math.abs(s);
      if (abs > peak) peak = abs;
      sumSquares += s * s;
      if (i >= tailStart) tailSumSquares += s * s;
      brightnessAccum += Math.abs(s - prev);
      prev = s;
    }
    const rms = Math.sqrt(sumSquares / data.length);
    const tailRms = Math.sqrt(tailSumSquares / Math.max(1, data.length - tailStart));
    const brightness = brightnessAccum / data.length;
    return { peak, rms, brightness, silentTail: tailRms < 0.01 };
  }

  // -------------------------------------------------------------- music ----

  startMusic() {
    if (!this.ctx || this._musicPlaying) return;
    this._musicPlaying = true;
    this.#buildMusicVoices();
    this.#scheduleNextChord();
    this.#scheduleNextBell();
    const now = this.ctx.currentTime;
    const g = this.musicGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(Math.max(taper(this._musicVolume), 0.0001), now + MUSIC_FADE_IN);
  }

  stopMusic() {
    if (!this._musicPlaying) return;
    this._musicPlaying = false;
    clearTimeout(this._chordTimer);
    clearTimeout(this._bellTimer);
    if (this.ctx) {
      const now = this.ctx.currentTime;
      const g = this.musicGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + MUSIC_FADE_OUT);
    }
    const nodes = this._musicNodes;
    this._musicNodes = null;
    setTimeout(() => {
      if (nodes) this.#teardownMusicVoices(nodes);
    }, (MUSIC_FADE_OUT + 0.1) * 1000);
  }

  #buildMusicVoices() {
    const ctx = this.ctx;
    const nodes = { drone: [], pads: [], lfo: null };

    // Drone: two near-unison sawtooths for a slow beat-throb, dry (never
    // through the delay), never retuned, never restarted -- the ocean floor.
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.09;
    const droneFilter = makeFilter(ctx, 'lowpass', 220, 0.6);
    droneGain.connect(droneFilter);
    droneFilter.connect(this.musicGain);
    for (const freq of [55, 55.15]) {
      const osc = makeOsc(ctx, 'sawtooth', freq);
      osc.connect(droneGain);
      osc.start();
      nodes.drone.push(osc);
    }
    nodes.droneGain = droneGain;
    nodes.droneFilter = droneFilter;

    // Shared pad filter, swept by a slow LFO for a "breathing" feel.
    const padFilter = makeFilter(ctx, 'lowpass', 700, 0.9);
    const lfo = makeOsc(ctx, 'sine', MUSIC_FILTER_LFO_HZ);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 500;
    lfo.connect(lfoGain);
    lfoGain.connect(padFilter.frequency);
    lfo.start();
    nodes.lfo = lfo;
    nodes.lfoGain = lfoGain;
    nodes.padFilter = padFilter;
    padFilter.connect(this.musicGain);
    padFilter.connect(this.musicDelay);

    // Two alternating pad voices -- crossfaded on every chord change,
    // since retuning a live oscillator glides audibly.
    for (let i = 0; i < 2; i++) {
      const padGain = ctx.createGain();
      padGain.gain.value = 0;
      padGain.connect(padFilter);
      nodes.pads.push({ oscs: [], gain: padGain });
    }

    this._musicNodes = nodes;
    this._activePad = 0;
    this.#retunePad(0, this._currentChord);
    nodes.pads[0].gain.gain.value = PAD_PEAK;
  }

  #retunePad(padIndex, chordName) {
    const ctx = this.ctx;
    const pad = this._musicNodes.pads[padIndex];
    for (const o of pad.oscs) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
      try {
        o.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    pad.oscs = [];
    for (const freq of MUSIC_CHORDS[chordName]) {
      const tri = makeOsc(ctx, 'triangle', freq);
      tri.connect(pad.gain);
      tri.start();
      pad.oscs.push(tri);

      const sine = makeOsc(ctx, 'sine', freq * 2);
      const sineGain = ctx.createGain();
      sineGain.gain.value = 0.4;
      sine.connect(sineGain);
      sineGain.connect(pad.gain);
      sine.start();
      pad.oscs.push(sine);
    }
  }

  #advanceChord() {
    const next = weightedPick(MUSIC_TRANSITIONS[this._currentChord]);
    const nextPad = this._activePad === 0 ? 1 : 0;
    this.#retunePad(nextPad, next);

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const activeGain = this._musicNodes.pads[this._activePad].gain.gain;
    const nextGain = this._musicNodes.pads[nextPad].gain.gain;
    activeGain.cancelScheduledValues(now);
    activeGain.setValueAtTime(activeGain.value, now);
    activeGain.linearRampToValueAtTime(0, now + MUSIC_CROSSFADE);
    nextGain.cancelScheduledValues(now);
    nextGain.setValueAtTime(0, now);
    nextGain.linearRampToValueAtTime(PAD_PEAK, now + MUSIC_CROSSFADE);

    this._activePad = nextPad;
    this._currentChord = next;
  }

  #scheduleNextChord() {
    const [lo, hi] = MUSIC_CHORD_SECONDS;
    const delay = (lo + Math.random() * (hi - lo)) * 1000;
    this._chordTimer = setTimeout(() => {
      if (!this._musicPlaying) return;
      this.#advanceChord();
      this.#scheduleNextChord();
    }, delay);
  }

  #scheduleNextBell() {
    const [lo, hi] = MUSIC_BELL_SECONDS;
    const delay = (lo + Math.random() * (hi - lo)) * 1000;
    this._bellTimer = setTimeout(() => {
      if (!this._musicPlaying) return;
      this.#playBell();
      this.#scheduleNextBell();
    }, delay);
  }

  #playBell() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const chordFreqs = MUSIC_CHORDS[this._currentChord];
    const base = chordFreqs[Math.floor(Math.random() * chordFreqs.length)];
    const freq = base * 4; // up two octaves off the *current* chord -- can never clash
    const decay = 3.5 + Math.random() * 2.5;

    const bellGain = ctx.createGain();
    bellGain.connect(this.musicGain);
    bellGain.connect(this.musicDelay);
    envelope(bellGain.gain, now, { peak: 0.055, attack: 0.01, decay });

    const sine = makeOsc(ctx, 'sine', freq);
    sine.connect(bellGain);
    sine.start(now);
    sine.stop(now + decay + 0.1);

    const tri = makeOsc(ctx, 'triangle', freq * 2);
    const triGain = ctx.createGain();
    triGain.gain.value = 0.3;
    tri.connect(triGain);
    triGain.connect(bellGain);
    tri.start(now);
    tri.stop(now + decay + 0.1);
  }

  #teardownMusicVoices(nodes) {
    const all = [...nodes.drone, nodes.lfo, ...nodes.pads.flatMap((p) => p.oscs)];
    for (const n of all) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    for (const gainNode of [nodes.droneGain, nodes.droneFilter, nodes.lfoGain, nodes.padFilter]) {
      try {
        gainNode.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    for (const p of nodes.pads) {
      try {
        p.gain.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}
