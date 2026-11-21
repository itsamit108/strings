/**
 * Frame-exact export. Every frame is simulated at a fixed time step and
 * handed straight to the hardware video encoder (WebCodecs), so the file
 * never drops a frame and usually finishes faster than the song plays.
 */
import { ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer } from 'mp4-muxer';
import type { Analysis } from '../analysis/types';
import type { PlateRenderer } from '../render/renderer';

export interface OfflineExportOptions {
  renderer: PlateRenderer;
  canvas: HTMLCanvasElement;
  audio: AudioBuffer;
  analysis: Analysis;
  width: number;
  height: number;
  fps: number;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
  /** When given, the video is written to disk as it is made instead of held in memory. */
  fileStream?: FileSystemWritableFileStream;
}

export class ExportUnsupportedError extends Error {}

export function offlineExportAvailable(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined'
  );
}

type VideoMux = 'avc' | 'hevc' | 'vp9' | 'av1';

async function pickVideo(width: number, height: number, fps: number) {
  // Fine glowing lines on a dark background need a generous bitrate to stay clean.
  const bitrate = Math.min(80e6, Math.max(5e6, Math.round(width * height * fps * 0.2)));
  const candidates: [string, VideoMux][] = [
    ['avc1.640034', 'avc'], ['avc1.640033', 'avc'], ['avc1.64002a', 'avc'], ['avc1.4d002a', 'avc'],
    ['avc1.42002a', 'avc'], ['hvc1.1.6.L153.B0', 'hevc'], ['vp09.00.51.08', 'vp9'], ['av01.0.12M.08', 'av1'],
  ];
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
    for (const [codec, mux] of candidates) {
      const config: VideoEncoderConfig = {
        codec, width, height, bitrate, framerate: fps, hardwareAcceleration,
        latencyMode: 'quality',
        ...(mux === 'avc' ? { avc: { format: 'avc' as const } } : {}),
        ...(mux === 'hevc' ? { hevc: { format: 'hevc' as const } } : {}),
      };
      try {
        const r = await VideoEncoder.isConfigSupported(config);
        if (r.supported) return { config, mux };
      } catch { /* try the next one */ }
    }
  }
  return null;
}

async function pickAudio(sampleRate: number, numberOfChannels: number) {
  const candidates: [string, 'aac' | 'opus', number][] = [['mp4a.40.2', 'aac', 192000], ['opus', 'opus', 160000]];
  for (const [codec, mux, bitrate] of candidates) {
    const config: AudioEncoderConfig = { codec, sampleRate, numberOfChannels, bitrate };
    try {
      const r = await AudioEncoder.isConfigSupported(config);
      if (r.supported) return { config, mux };
    } catch { /* try the next one */ }
  }
  return null;
}

const breathe = (): Promise<void> => {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return s?.yield ? s.yield() : new Promise((r) => setTimeout(r, 0));
};

/**
 * Surround sound (5.1, 7.1) folded down to stereo with the Web Audio speaker rules, which keep the
 * centre channel (usually the voice) instead of dropping it. Mono and stereo pass through unchanged.
 */
async function stereo(audio: AudioBuffer): Promise<AudioBuffer> {
  if (audio.numberOfChannels <= 2) return audio;
  const ctx = new OfflineAudioContext(2, audio.length, audio.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.channelInterpretation = 'speakers';
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

/** Returns the finished file, or null when it was written to `fileStream`. */
export async function exportOffline(o: OfflineExportOptions): Promise<Blob | null> {
  if (!offlineExportAvailable()) throw new ExportUnsupportedError('WebCodecs is missing.');
  const source = await stereo(o.audio);
  const channels = source.numberOfChannels;
  const sr = o.audio.sampleRate;
  const video = await pickVideo(o.width, o.height, o.fps);
  const audio = await pickAudio(sr, channels);
  if (!video || !audio) throw new ExportUnsupportedError('No usable video or audio encoder.');

  const target = o.fileStream ? new FileSystemWritableFileStreamTarget(o.fileStream) : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: video.mux, width: o.width, height: o.height, frameRate: o.fps },
    audio: { codec: audio.mux, numberOfChannels: channels, sampleRate: sr },
    fastStart: o.fileStream ? false : 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure: Error | null = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  venc.configure(video.config);
  const aenc = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  aenc.configure(audio.config);

  const pcm = Array.from({ length: channels }, (_, c) => source.getChannelData(c));
  const length = source.length;
  const block = Math.round(sr * 0.1);
  let fed = 0;
  const feedAudio = (until: number) => {
    while (fed < until) {
      const n = Math.min(block, length - fed);
      if (n <= 0) break;
      const data = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) data.set(pcm[c].subarray(fed, fed + n), c * n);
      const frame = new AudioData({
        format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: channels,
        timestamp: Math.round((fed / sr) * 1e6), data,
      });
      aenc.encode(frame);
      frame.close();
      fed += n;
    }
  };

  const r = o.renderer;
  const liveOffset = r.centerOffset, liveCompact = r.compact;
  r.governorPaused = true; // export always draws at full resolution
  r.centerOffset = 0;
  r.compact = false;
  r.resize(o.width, o.height, true);
  r.setSafeTop(0); // the video has no controls over it
  r.seed(o.analysis.seed);

  // Exactly as long as the uploaded sound, to the nearest frame.
  const total = Math.max(1, Math.round(o.audio.duration * o.fps));
  const frameUs = 1e6 / o.fps;
  try {
    for (let i = 0; i < total; i++) {
      if (o.signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (failure) throw failure;
      const t = i / o.fps;
      r.frame(t, 1 / o.fps, t < o.audio.duration, 1 / o.fps);
      const frame = new VideoFrame(o.canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      venc.encode(frame, { keyFrame: i % (o.fps * 2) === 0 });
      frame.close();
      feedAudio(Math.min(length, Math.ceil((t + 0.5) * sr)));
      while (venc.encodeQueueSize > 6 && !failure) await new Promise((res) => setTimeout(res, 2));
      if (i % 3 === 0) {
        o.onProgress(i / total);
        await breathe();
      }
    }
    feedAudio(length);
    await venc.flush();
    await aenc.flush();
    if (failure) throw failure;
    muxer.finalize();
    o.onProgress(1);
    if (o.fileStream) {
      await o.fileStream.close();
      return null;
    }
    return new Blob([(target as ArrayBufferTarget).buffer], { type: 'video/mp4' });
  } catch (e) {
    if (o.fileStream) await o.fileStream.abort().catch(() => {});
    throw e;
  } finally {
    if (venc.state !== 'closed') venc.close();
    if (aenc.state !== 'closed') aenc.close();
    r.centerOffset = liveOffset;
    r.compact = liveCompact;
    r.governorPaused = false;
  }
}
