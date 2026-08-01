/**
 * Procedural audio (Web Audio API) — no asset files. A small bus mixer (master → sfx) plus
 * synthesised, positional gunfire/impacts/reload/death and a UI hitmarker tick. Positional
 * sounds route through a per-shot PannerNode placed at the world event; the player's own weapon
 * plays centred. The listener tracks the camera each frame.
 *
 * The AudioContext starts suspended (autoplay policy) and is resumed on the first user gesture
 * (the pointer-lock click). All methods are safe no-ops if audio is unavailable (e.g. headless).
 */
import type * as THREE from 'three/webgpu';

export interface Sfx {
  gunshot(pos?: THREE.Vector3): void;
  impact(pos: THREE.Vector3, flesh: boolean): void;
  hitmarker(headshot: boolean): void;
  reload(): void;
  enemyDeath(pos: THREE.Vector3): void;
}

export class AudioEngine implements Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  constructor() {
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain();
      this.sfxBus.gain.value = 1.0;
      this.sfxBus.connect(this.master);
      this.noise = this.makeNoise(1.0);
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

  gunshot(pos?: THREE.Vector3): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dest = pos ? this.panner(pos) : this.sfxBus!;
    const loud = pos ? 0.6 : 0.9;
    this.noiseBurst(dest, t, { filter: 'bandpass', freq: 1300 + Math.random() * 500, q: 0.6, gain: loud, decay: 0.13 });
    this.noiseBurst(dest, t, { filter: 'highpass', freq: 3500, q: 0.5, gain: loud * 0.4, decay: 0.04 });
    this.tone(dest, t, 'triangle', 90, loud * 0.5, 0.09);
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
    }
  }

  hitmarker(headshot: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(this.sfxBus!, t, 'square', headshot ? 1500 : 1050, 0.12, 0.05);
  }

  reload(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // mag out, mag in, chamber
    this.noiseBurst(this.sfxBus!, t, { filter: 'bandpass', freq: 2200, q: 1, gain: 0.35, decay: 0.05 });
    this.noiseBurst(this.sfxBus!, t + 0.55, { filter: 'bandpass', freq: 1800, q: 1, gain: 0.4, decay: 0.06 });
    this.noiseBurst(this.sfxBus!, t + 1.55, { filter: 'bandpass', freq: 3000, q: 1.4, gain: 0.45, decay: 0.05 });
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
  /** Start the low ambience bed (drone + wind). Idempotent. */
  startAmbience(): void {
    if (!this.ctx || this.ambienceOn) return;
    this.ambienceOn = true;
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0.14;
    bus.connect(this.master!);
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
