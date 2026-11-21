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
    this.ctx = new Ctor({ latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  /** Where extra listeners (such as a recorder) can tap the sound. */
  get output(): AudioNode { return this.gain; }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return await this.ctx.decodeAudioData(data);
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
    this.offset = Math.min(this.duration, this.offset + this.ctx.currentTime - this.startedAt);
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
