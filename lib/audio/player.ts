import { codecName, decodeWithWebCodecs, isMp4, mp4SoundCodec, readMp4Audio, toAdts } from './mp4audio';

/** Sample-accurate playback of a decoded song, with a clock the visuals can trust. */
export class Player {
  readonly ctx: AudioContext;
  private gain: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  buffer: AudioBuffer | null = null;
  playing = false;
  onEnded: (() => void) | null = null;
  onState: (() => void) | null = null;

  constructor() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // iPhone and iPad: without this, Web Audio is silent whenever the ring/silent switch is on.
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) { try { session.type = 'playback'; } catch { /* older Safari */ } }
    this.ctx = new Ctor({ latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  /** Where extra listeners (such as a recorder) can tap the sound. */
  get output(): AudioNode { return this.gain; }

  /**
   * Decodes a file. `rate`, when lower than the device's own, decodes at that sample rate instead:
   * a long recording then takes less memory (used only when full quality would not fit).
   */
  async decode(data: ArrayBuffer, rate?: number): Promise<AudioBuffer> {
    const dec: BaseAudioContext = rate && rate < this.ctx.sampleRate ? new OfflineAudioContext(1, 1, rate) : this.ctx;
    // decodeAudioData detaches the buffer it is given, so keep the original for the fallback.
    try {
      return await dec.decodeAudioData(data.slice(0));
    } catch (first) {
      // Chromium can't read fragmented MP4s (screen recorders, many downloads) and some MOVs.
      // Pull the sound frames out ourselves and decode those instead.
      if (!isMp4(data)) throw first;
      const track = readMp4Audio(data);
      if (!track) {
        const codec = mp4SoundCodec(data);
        throw new Error(codec === null ? 'no-sound-track' : `codec:${codecName(codec)}`);
      }
      const adts = toAdts(track);
      if (adts) {
        try {
          return await dec.decodeAudioData(adts);
        } catch { /* try WebCodecs below */ }
      }
      return await decodeWithWebCodecs(track, dec);
    }
  }

  load(buffer: AudioBuffer) {
    this.stopSource();
    this.buffer = buffer;
    this.offset = 0;
    this.playing = false;
    this.onState?.();
  }

  get duration() { return this.buffer?.duration ?? 0; }

  /** Seconds into the song that are being heard right now. */
  get time(): number {
    if (!this.playing) return this.offset;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.min(this.duration, Math.max(0, this.offset + this.ctx.currentTime - this.startedAt - latency));
  }

  private starting = false;

  async play() {
    if (!this.buffer || this.playing) return;
    if (this.starting) {
      // A tap while the browser is still waiting for permission to make sound.
      void this.ctx.resume();
      return;
    }
    if (this.ctx.state !== 'running') {
      this.starting = true;
      try { await this.ctx.resume(); } finally { this.starting = false; }
      if (!this.buffer || this.playing) return;
    }
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.playing = false;
      this.offset = this.duration;
      this.onState?.();
      this.onEnded?.();
    };
    src.start(0, this.offset);
    this.source = src;
    this.startedAt = this.ctx.currentTime;
    this.playing = true;
    this.onState?.();
  }

  pause() {
    if (!this.playing) return;
    // Stop where the listener is (what has reached the speakers), so the picture does not jump.
    this.offset = this.time;
    this.stopSource();
    this.playing = false;
    this.onState?.();
  }

  async seek(time: number) {
    const was = this.playing;
    if (was) { this.stopSource(); this.playing = false; }
    this.offset = Math.min(this.duration, Math.max(0, time));
    if (was) await this.play();
    else this.onState?.();
  }

  private stopSource() {
    const src = this.source;
    this.source = null;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch { /* already stopped */ }
      src.disconnect();
    }
  }

  dispose() {
    this.stopSource();
    void this.ctx.close();
  }
}
