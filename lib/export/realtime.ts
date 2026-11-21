/**
 * Fallback export for browsers without WebCodecs: record the canvas and the
 * sound while the song plays once from the start.
 */
import type { Player } from '../audio/player';

export interface RealtimeExportOptions {
  canvas: HTMLCanvasElement;
  player: Player;
  fps: number;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
}

export function realtimeExportAvailable(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

export async function exportRealtime(o: RealtimeExportOptions): Promise<Blob> {
  const mimeType = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error('This browser cannot record video.');

  const dest = o.player.ctx.createMediaStreamDestination();
  o.player.output.connect(dest);
  const stream = o.canvas.captureStream(o.fps);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const pixels = o.canvas.width * o.canvas.height;
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: Math.min(40e6, Math.round(pixels * o.fps * 0.13)),
    audioBitsPerSecond: 192000,
  });
  const parts: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise<void>((res) => { recorder.onstop = () => res(); });

  try {
    await o.player.seek(0);
    recorder.start(1000);
    await o.player.play();
    await new Promise<void>((resolve, reject) => {
      const tick = setInterval(() => {
        if (o.signal.aborted) { clearInterval(tick); reject(new DOMException('Export cancelled', 'AbortError')); return; }
        o.onProgress(o.player.time / Math.max(0.01, o.player.duration));
        if (!o.player.playing) { clearInterval(tick); resolve(); }
      }, 200);
    });
    recorder.stop();
    await stopped;
    return new Blob(parts, { type: mimeType.split(';')[0] });
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    o.player.pause();
    o.player.output.disconnect(dest);
    stream.getTracks().forEach((t) => t.stop());
  }
}
