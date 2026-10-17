/**
 * Procedural audio (Web Audio API) — no asset files. A small bus mixer (master → sfx, plus a
 * courtyard reverb send) and synthesised, positional gunfire/impacts/reload/death/near-miss and a
 * UI hitmarker tick. Positional sounds route through a per-event PannerNode at the world event;
 * the player's own weapon plays centred. The listener tracks the camera each frame.
 *
 * Gunshots are layered like recorded ones: a sharp transient crack, a mid "body", a low thump
 * with a pitch drop, and a late mechanical click — then a convolution tail (a synthetic impulse
 * response with early reflections off the four buildings) and a slap-back delay.
 *
 * The AudioContext starts suspended (autoplay policy) and is resumed on the first user gesture
 * (the pointer-lock click). All methods are safe no-ops if audio is unavailable (e.g. headless).
 */
import type * as THREE from 'three/webgpu';

export type ReloadBeat = 'magOut' | 'magIn' | 'slap' | 'bolt';

export interface Sfx {
  gunshot(pos?: THREE.Vector3): void;
  impact(pos: THREE.Vector3, flesh: boolean): void;
  hitmarker(headshot: boolean): void;
  /** Start of a reload (mag release). Later beats via reloadBeat(). */
  reload(): void;
  reloadBeat(beat: ReloadBeat): void;
  enemyDeath(pos: THREE.Vector3): void;
  /** A round passing close to the listener at `pos`: supersonic crack + whizz. */
  nearMiss(pos: THREE.Vector3): void;
}

export class AudioEngine implements Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private slap: DelayNode | null = null;
  private noise: AudioBuffer | null = null;

  constructor() {
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      // Brick-wall-ish limiter: full-auto stacks voices; never clip the output.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 2;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      this.master.connect(limiter).connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 1.0;
      this.sfxBus.connect(this.master);
      this.noise = this.makeNoise(1.0);

      // Courtyard: convolution tail + one slap-back off the facing building.
      const verb = this.ctx.createConvolver();
      verb.buffer = this.makeImpulse(1.4);
      const verbOut = this.ctx.createGain();
      verbOut.gain.value = 0.55;
      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 1;
      this.reverbSend.connect(verb).connect(verbOut).connect(this.master);
      this.slap = this.ctx.createDelay(0.5);
      this.slap.delayTime.value = 0.115;
      const slapFilter = this.ctx.createBiquadFilter();
      slapFilter.type = 'lowpass';
      slapFilter.frequency.value = 2200;
      const slapGain = this.ctx.createGain();
      slapGain.gain.value = 0.28;
      this.slap.connect(slapFilter).connect(slapGain).connect(this.master);
    } catch {
      this.ctx = null;
    }
  }

  /** Resume on a user gesture (audio autoplay policy). */
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Master volume, 0..1 (settings). */
  setMasterVolume(v: number): void {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v)) * 0.8;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Stereo impulse response: early reflections (the four walls) + a dense exponential tail. */
  private makeImpulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const early = [0.021, 0.034, 0.047, 0.063, 0.081, 0.112];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / ctx.sampleRate;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 4.2) * 0.35 * Math.min(1, t / 0.012);
      }
      for (const e of early) {
        const i0 = Math.floor((e + ch * 0.004 + Math.random() * 0.003) * ctx.sampleRate);
        for (let k = 0; k < 90 && i0 + k < len; k++) d[i0 + k] += (Math.random() * 2 - 1) * 0.6 * Math.exp(-k / 25);
      }
    }
    return buf;
  }

  /** Route a voice to the dry bus/panner plus the courtyard reverb (+ optional slap-back). */
  private sends(dry: AudioNode, wet: number, slap: number): AudioNode {
    const ctx = this.ctx!;
    const split = ctx.createGain();
    split.connect(dry);
    const w = ctx.createGain();
    w.gain.value = wet;
    split.connect(w).connect(this.reverbSend!);
    if (slap > 0) {
      const sg = ctx.createGain();
      sg.gain.value = slap;
      split.connect(sg).connect(this.slap!);
    }
    return split;
  }

  /** Update the Web Audio listener from the camera. */
  setListener(pos: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void {
    const l = this.ctx?.listener;
    if (!l) return;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  private panner(pos: THREE.Vector3): AudioNode {
    const ctx = this.ctx!;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 5;
    p.maxDistance = 70;
    p.rolloffFactor = 1;
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(this.sfxBus!);
    return p;
  }

  private noiseBurst(dest: AudioNode, t: number, opts: {
    filter: BiquadFilterType;
    freq: number;
    q: number;
    gain: number;
    decay: number;
  }): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = opts.filter;
    f.frequency.value = opts.freq;
    f.Q.value = opts.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(opts.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + opts.decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t);
    src.stop(t + opts.decay + 0.02);
  }

  private tone(dest: AudioNode, t: number, type: OscillatorType, freq: number, gain: number, decay: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  /** Sine thump with a fast downward pitch sweep (the chest-punch of a rifle report). */
  private thump(dest: AudioNode, t: number, from: number, to: number, gain: number, decay: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + decay * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0006, t + decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  gunshot(pos?: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const own = !pos;
    // Distant shots lose highs and are mostly room; your own rifle is close, dry and heavy.
    const dry = pos ? this.panner(pos) : this.sfxBus!;
    const dest = this.sends(dry, own ? 0.45 : 0.8, own ? 0.5 : 0.3);
    const loud = own ? 0.95 : 0.65;
    const jitter = 0.92 + Math.random() * 0.16;
    if (own) this.duckAmbience(t);
    this.noiseBurst(dest, t, { filter: 'highpass', freq: 3800, q: 0.4, gain: loud * 1.1, decay: 0.03 }); // crack
    this.noiseBurst(dest, t, { filter: 'bandpass', freq: 2600 * jitter, q: 0.9, gain: loud * 1.3, decay: 0.05 }); // bite (1–5 kHz)
    this.noiseBurst(dest, t, { filter: 'bandpass', freq: 1100 * jitter, q: 0.7, gain: loud * 0.9, decay: own ? 0.1 : 0.14 }); // body
    this.noiseBurst(dest, t, { filter: 'lowpass', freq: 420, q: 0.5, gain: loud * 0.7, decay: 0.16 }); // blast
    this.thump(dest, t, 120 * jitter, 42, loud * (own ? 1.1 : 0.6), 0.14); // thump
    if (own) this.noiseBurst(dest, t + 0.028, { filter: 'bandpass', freq: 3600, q: 2.5, gain: 0.22, decay: 0.012 }); // bolt
  }

  nearMiss(pos: THREE.Vector3): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dest = this.panner(pos);
    this.noiseBurst(dest, t, { filter: 'bandpass', freq: 2800, q: 1.2, gain: 0.9, decay: 0.03 }); // supersonic crack
    // Whizz: a narrow noise band sweeping down as the round passes.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(3400, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0006, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.18);
    src.connect(f).connect(g).connect(dest);
    src.start(t);
    src.stop(t + 0.2);
  }

  impact(pos: THREE.Vector3, flesh: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.panner(pos);
    if (flesh) {
      this.noiseBurst(dest, t, { filter: 'lowpass', freq: 700, q: 0.5, gain: 0.5, decay: 0.09 });
      this.tone(dest, t, 'sine', 140, 0.25, 0.06);
    } else {
      this.noiseBurst(dest, t, { filter: 'highpass', freq: 2500, q: 0.5, gain: 0.35, decay: 0.05 });
      this.thump(dest, t, 260, 120, 0.18, 0.05); // concrete thunk
      if (Math.random() < 0.15) {
        // Occasional ricochet whine.
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(2600 + Math.random() * 900, t + 0.01);
        o.frequency.exponentialRampToValueAtTime(900, t + 0.3);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.09, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0006, t + 0.32);
        o.connect(g).connect(dest);
        o.start(t + 0.01);
        o.stop(t + 0.34);
      }
    }
  }

  hitmarker(headshot: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Crisp tick (filtered click + short high sine); headshots get a brighter second tick.
    this.noiseBurst(this.sfxBus!, t, { filter: 'highpass', freq: 5000, q: 0.7, gain: 0.25, decay: 0.012 });
    this.tone(this.sfxBus!, t, 'sine', 2400, 0.07, 0.03);
    if (headshot) this.tone(this.sfxBus!, t + 0.035, 'sine', 3100, 0.06, 0.04);
  }

  reload(): void {
    this.reloadBeat('magOut');
  }

  reloadBeat(beat: ReloadBeat): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const bus = this.sfxBus!;
    switch (beat) {
      case 'magOut': // release click + mag sliding free
        this.noiseBurst(bus, t, { filter: 'bandpass', freq: 3200, q: 2, gain: 0.3, decay: 0.015 });
        this.noiseBurst(bus, t + 0.02, { filter: 'bandpass', freq: 1500, q: 0.8, gain: 0.25, decay: 0.09 });
        break;
      case 'magIn': // mag seating into the well
        this.noiseBurst(bus, t, { filter: 'bandpass', freq: 1700, q: 1, gain: 0.4, decay: 0.05 });
        this.thump(bus, t, 300, 160, 0.2, 0.05);
        break;
      case 'slap': // palm slap on the mag base
        this.noiseBurst(bus, t, { filter: 'lowpass', freq: 900, q: 0.6, gain: 0.45, decay: 0.05 });
        this.thump(bus, t, 180, 90, 0.25, 0.06);
        break;
      case 'bolt': // bolt release slamming home
        this.noiseBurst(bus, t, { filter: 'bandpass', freq: 3000, q: 1.6, gain: 0.5, decay: 0.035 });
        this.noiseBurst(bus, t + 0.01, { filter: 'bandpass', freq: 1200, q: 0.9, gain: 0.35, decay: 0.07 });
        this.thump(bus, t, 220, 110, 0.2, 0.05);
        break;
    }
  }

  enemyDeath(pos: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = this.panner(pos);
    this.tone(dest, t, 'sawtooth', 180, 0.35, 0.28);
    this.noiseBurst(dest, t + 0.05, { filter: 'lowpass', freq: 500, q: 0.4, gain: 0.4, decay: 0.35 });
  }

  /** Player footstep (centred, subtle). */
  footstep(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(this.sfxBus!, t, { filter: 'lowpass', freq: 380 + Math.random() * 140, q: 0.6, gain: 0.2, decay: 0.08 });
    this.tone(this.sfxBus!, t, 'sine', 68, 0.1, 0.05);
  }

  private ambienceOn = false;
  private ambienceBus: GainNode | null = null;
  private static readonly AMBIENCE_LEVEL = 0.035; // ≈ −40 dBFS bed: under gunfire, not over it

  /** Dip the ambience ~4 dB under the player's own fire, recovering over ~0.6 s. */
  private duckAmbience(t: number): void {
    const g = this.ambienceBus?.gain;
    if (!g) return;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(AudioEngine.AMBIENCE_LEVEL * 0.63, t, 0.01);
    g.setTargetAtTime(AudioEngine.AMBIENCE_LEVEL, t + 0.08, 0.25);
  }
  /** Start the low ambience bed (drone + wind). Idempotent. */
  startAmbience(): void {
    if (!this.ctx || this.ambienceOn) return;
    this.ambienceOn = true;
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = AudioEngine.AMBIENCE_LEVEL;
    bus.connect(this.master!);
    this.ambienceBus = bus;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 340;
    lp.connect(bus);
    for (const f of [48, 48.3, 72]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g).connect(lp);
      o.start();
    }
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 500;
    wf.Q.value = 0.4;
    const wg = ctx.createGain();
    wg.gain.value = 0.16;
    wind.connect(wf).connect(wg).connect(bus);
    wind.start();
  }
}
