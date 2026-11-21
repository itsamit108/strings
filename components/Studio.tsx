'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeAudio, synthesizeDemo } from '@/lib/analysis/analyze';
import type { Analysis } from '@/lib/analysis/types';
import { Player } from '@/lib/audio/player';
import { DEMO_TITLE } from '@/lib/demo/synth';
import { ExportUnsupportedError, exportOffline, offlineExportAvailable } from '@/lib/export/offline';
import { exportRealtime, realtimeExportAvailable } from '@/lib/export/realtime';
import { toCss } from '@/lib/render/color';
import { PlateRenderer } from '@/lib/render/renderer';
import { DESIGN_NAMES, DESIGNS, type Design } from '@/lib/analysis/sections';
import { readSongInfo } from '@/lib/audio/tags';
import { NOTE_HUES, vivid } from '@/lib/render/lightmusic';

type Phase = 'idle' | 'loading' | 'ready';
type Shape = 'landscape' | 'portrait' | 'square';
/** How the picture is framed on screen: fill the screen, or a 9:16 phone frame (Reels, Shorts). */
type Frame = 'screen' | 'tall';
/** Reels and Shorts both take videos up to three minutes. */
const SHORTS_LIMIT = 180;
type ExportState =
  | { stage: 'options' }
  | { stage: 'running'; live: boolean }
  | { stage: 'done'; url: string | null; name: string }
  | { stage: 'error'; message: string };

interface Song { title: string; artist: string; showCaption: boolean; analysis: Analysis; audio: AudioBuffer }

const MAX_PIXELS = 3840 * 2160;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const even = (n: number) => Math.round(n / 2) * 2;
/** "by Artist", or nothing when the artist is not known. */
const byline = (s: { artist: string }) => (s.artist ? `by ${s.artist}` : '');

function drawArc(canvas: HTMLCanvasElement, a: Analysis) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);
  const step = Math.max(2, Math.round(3 * dpr)), mid = h / 2;
  for (let x = 0; x < w; x += step) {
    const i = Math.min(a.arc.length - 1, Math.floor((x / w) * a.arc.length));
    const half = Math.max(dpr, a.arc[i] * (mid - dpr));
    // arcHue is a place on the circle of fifths; turn it back into a note and use that note's light.
    g.fillStyle = toCss(vivid(0.84, NOTE_HUES[(7 * Math.round(a.arcHue[i] * 12)) % 12], 0.6));
    g.fillRect(x, mid - half, Math.max(1, step - dpr), half * 2);
  }
}

export default function Studio() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const arcRef = useRef<HTMLCanvasElement>(null);
  const arcPlayedRef = useRef<HTMLCanvasElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const exportDialog = useRef<HTMLDialogElement>(null);
  const aboutDialog = useRef<HTMLDialogElement>(null);

  const renderer = useRef<PlateRenderer | null>(null);
  const player = useRef<Player | null>(null);
  const songRef = useRef<Song | null>(null);
  const offline = useRef(false);
  /** true while the fallback recorder holds the canvas at the export size */
  const holdSize = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const fit = useRef<() => void>(() => {});
  const lastSeek = useRef(0);
  /** counts loads, so a slow earlier file never replaces a later one */
  const loadId = useRef(0);
  const phaseRef = useRef<Phase>('idle');
  const designRef = useRef<HTMLElement>(null);
  const infoDialog = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<Frame>('screen');

  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [song, setSong] = useState<Song | null>(null);
  const [playing, setPlaying] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [exp, setExp] = useState<ExportState | null>(null);
  const [expProgress, setExpProgress] = useState(0);
  const [shape, setShape] = useState<Shape>('landscape');
  const [size, setSize] = useState(1080);
  const [fps, setFps] = useState(60);
  const [draft, setDraft] = useState({ title: '', artist: '', show: true });
  const [frame, setFrame] = useState<Frame>('screen');

  const chooseFrame = (next: Frame) => {
    frameRef.current = next;
    setFrame(next);
    setShape(next === 'tall' ? 'portrait' : 'landscape');
    // The canvas changes size with the CSS class; measure once it has.
    requestAnimationFrame(() => fit.current());
  };

  /** Puts the song's title and artist on the picture, once the fonts it uses are ready. */
  const applyCaption = useCallback((s: Song) => {
    const go = () => renderer.current?.setCaption(s.title, byline(s), s.showCaption);
    go();
    if (document.fonts) {
      void Promise.all([
        document.fonts.load('300 64px "Fraunces Variable"'),
        document.fonts.load('450 24px "Instrument Sans Variable"'),
      ]).then(go, go);
    }
  }, []);

  const getPlayer = useCallback(() => {
    if (!player.current) {
      const p = new Player();
      p.onState = () => setPlaying(p.playing);
      player.current = p;
    }
    return player.current;
  }, []);

  // ---- renderer and frame loop --------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!, stage = stageRef.current!;
    let r: PlateRenderer;
    try {
      r = new PlateRenderer(canvas);
      r.showTextOnPage(true);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    renderer.current = r;
    const s = songRef.current;
    if (s) r.setSong(s.analysis);
    // For checking one design on its own: ?design=plate (ribbons, rings, plate, ripples, membrane, faraday, strings).
    // Honour the system's "reduce motion" setting on screen (exported videos always have full motion).
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
    r.reducedMotion = calm.matches;
    const onCalm = () => { r.reducedMotion = calm.matches; };
    calm.addEventListener('change', onCalm);
    const forced = new URLSearchParams(location.search).get('design') as Design | null;
    if (forced && DESIGNS.includes(forced)) r.force = forced;

    fit.current = () => {
      if (offline.current || holdSize.current) return;
      const dpr = window.devicePixelRatio || 1;
      // The canvas fills the stage, or a 9:16 frame inside it.
      let w = (canvas.clientWidth || stage.clientWidth) * dpr, h = (canvas.clientHeight || stage.clientHeight) * dpr;
      const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
      w *= k; h *= k;
      // Leave room for the controls under the plate.
      const tall = h > w;
      const first = phaseRef.current !== 'ready';
      const framed = !first && frameRef.current === 'tall';
      r.compact = first; // on the first screen the waves stay clear of the text
      // In the 9:16 frame, lay out exactly as the exported video will be.
      r.centerOffset = first ? (tall ? 0.24 : 0.1) : framed ? 0 : tall ? 0.02 : 0.04;
      r.resize(w, h);
      // Keep the title and artist on the picture clear of the controls along the top.
      const cb = canvas.getBoundingClientRect();
      let safe = 0;
      const top = stage.querySelector('.top');
      if (top && cb.height > cb.width) {
        for (const el of Array.from(top.querySelectorAll('.mark, .tools > *'))) {
          const b = el.getBoundingClientRect();
          if (b.width && b.right > cb.left + cb.width * 0.15 && b.left < cb.right - cb.width * 0.15) safe = Math.max(safe, (b.bottom - cb.top) / cb.height);
        }
      }
      r.setSafeTop(Math.max(0, safe));
      const a = songRef.current?.analysis;
      if (a) for (const c of [arcRef.current, arcPlayedRef.current]) if (c) drawArc(c, a);
    };
    fit.current();
    const ro = new ResizeObserver(() => fit.current());
    ro.observe(stage);

    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const wall = (now - last) / 1000;
      last = now;
      if (offline.current) return;
      const p = player.current;
      const t = p?.time ?? 0;
      try {
        r.frame(t, wall, !!p?.playing, wall);
      } catch (e) {
        cancelAnimationFrame(raf);
        setError((e as Error).message);
        return;
      }
      const d = p?.duration ?? 0;
      if (d > 0) {
        const f = Math.min(1, t / d) * 100;
        if (playedRef.current) playedRef.current.style.clipPath = `inset(0 ${100 - f}% 0 0)`;
        if (headRef.current) headRef.current.style.left = `${f}%`;
        if (nowRef.current) nowRef.current.textContent = clock(t);
        if (sliderRef.current) {
          sliderRef.current.setAttribute('aria-valuenow', String(Math.round(t)));
          sliderRef.current.setAttribute('aria-valuetext', `${clock(t)} of ${clock(d)}`);
        }
        const name = DESIGN_NAMES[r.current];
        if (designRef.current && designRef.current.textContent !== name) designRef.current.textContent = name;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      calm.removeEventListener('change', onCalm);
      ro.disconnect();
      r.dispose();
      renderer.current = null;
    };
  }, []);

  useEffect(() => () => { player.current?.dispose(); player.current = null; }, []);

  // ---- loading a song -----------------------------------------------------
  const adoptBuffer = useCallback(async (audio: AudioBuffer, title: string, artist: string, id: number) => {
    setStatus('Measuring the sound');
    setProgress(0);
    const analysis = await analyzeAudio(audio, setProgress);
    if (id !== loadId.current) return; // a newer file was opened meanwhile
    const s: Song = { title, artist, showCaption: true, analysis, audio };
    songRef.current = s;
    renderer.current?.setSong(analysis);
    applyCaption(s);
    const p = getPlayer();
    p.load(audio);
    setSong(s);
    setPhase('ready');
    document.documentElement.style.setProperty('--song', toCss(vivid(0.84, NOTE_HUES[analysis.key.tonic], 0.7)));
    void p.play();
  }, [getPlayer, applyCaption]);

  /** Says why a file gave no sound, as exactly as the file allows. */
  const noSound = (name: string, e: unknown) => {
    const m = (e as Error)?.message ?? '';
    if (m === 'no-sound-track') return `"${name}" has no sound track: it is a silent video. Choose a video with sound, or a song.`;
    if (m.startsWith('codec:')) return `The sound in "${name}" is stored as ${m.slice(6)}, which this browser cannot decode. Try an MP3, WAV, FLAC, OGG or M4A file.`;
    return `"${name}" has no sound this browser can read. Try an MP3, WAV, FLAC, OGG or M4A file, or an MP4 or WebM video with a soundtrack.`;
  };

  const fail = useCallback((message: string) => {
    setError(message);
    setPhase(songRef.current ? 'ready' : 'idle');
  }, []);

  const openFile = useCallback(async (file: File) => {
    const id = ++loadId.current;
    const p = getPlayer();
    void p.ctx.resume();
    p.pause();
    setError('');
    setPhase('loading');
    setStatus('Reading the file');
    setProgress(0);
    let audio: AudioBuffer;
    const info = readSongInfo(file);
    // A decoded song lives in memory as 32-bit samples. If full quality would not fit this device,
    // decode at a lower sample rate (each step still above what the analysis needs, 10 kHz bands).
    const { duration } = await info;
    let rate: number | undefined;
    if (duration) {
      const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
      const phone = window.matchMedia('(pointer: coarse)').matches;
      const budget = (gb ? gb * 0.25 : phone ? 1 : 2) * 1e9;
      // stereo song + a mono copy for measuring, 4 bytes each
      const need = (r: number) => duration * r * 3 * 4;
      const full = p.ctx.sampleRate;
      if (need(full) > budget) {
        rate = [32000, 24000, 22050].find((r) => need(r) <= budget);
        if (!rate) {
          fail(`"${file.name}" is ${clock(duration)} long, more than this device has memory for. Try a shorter file, or a computer.`);
          return;
        }
      }
    }
    try {
      audio = await p.decode(await file.arrayBuffer(), rate);
    } catch (e) {
      if (id === loadId.current) fail(noSound(file.name, e));
      return;
    }
    if (id !== loadId.current) return;
    try {
      const { title, artist } = await info;
      await adoptBuffer(audio, title, artist, id);
    } catch (e) {
      if (id === loadId.current) fail(`The sound could not be measured: ${(e as Error).message}`);
    }
  }, [fail, getPlayer, adoptBuffer]);

  const playDemo = useCallback(async () => {
    const id = ++loadId.current;
    const p = getPlayer();
    void p.ctx.resume();
    p.pause();
    setError('');
    setPhase('loading');
    setStatus('Composing the demo');
    setProgress(0);
    try {
      const { left, right } = await synthesizeDemo(44100);
      const audio = p.ctx.createBuffer(2, left.length, 44100);
      audio.getChannelData(0).set(left);
      audio.getChannelData(1).set(right);
      await adoptBuffer(audio, DEMO_TITLE, 'Strings', id);
    } catch (e) {
      if (id === loadId.current) fail(`The demo could not start: ${(e as Error).message}`);
    }
  }, [fail, getPlayer, adoptBuffer]);

  useEffect(() => {
    phaseRef.current = phase;
    fit.current(); // the plate moves to make room for whatever is on screen
  }, [song, phase]);

  // ---- things the platform offers ------------------------------------------
  useEffect(() => {
    setCanFullscreen(!!document.fullscreenEnabled);
    setShape(window.innerHeight > window.innerWidth ? 'portrait' : 'landscape');
    if (window.matchMedia('(pointer: coarse)').matches) setFps(30);
    // Installed app: files opened "with Strings" arrive here.
    const lq = (window as unknown as { launchQueue?: { setConsumer: (fn: (p: { files: FileSystemFileHandle[] }) => void) => void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      const handle = params.files?.[0];
      if (handle) void openFile(await handle.getFile());
    });
  }, [openFile]);

  useEffect(() => {
    // Keep the screen awake while a song plays.
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    if (playing && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then((l) => { if (cancelled) void l.release(); else lock = l; }).catch(() => {});
    }
    return () => { cancelled = true; void lock?.release(); };
  }, [playing]);

  useEffect(() => {
    if (!song || !('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: song.artist || 'Strings' });
    navigator.mediaSession.setActionHandler('play', () => void player.current?.play());
    navigator.mediaSession.setActionHandler('pause', () => player.current?.pause());
  }, [song]);

  const openInfo = () => {
    const s = songRef.current;
    if (!s) return;
    setDraft({ title: s.title, artist: s.artist, show: s.showCaption });
    infoDialog.current?.showModal();
  };

  /** Clicking the title shown on the picture opens it for editing. */
  const onCaption = (e: React.PointerEvent<HTMLCanvasElement>, click: boolean) => {
    const r = renderer.current, c = e.currentTarget;
    if (!r || !songRef.current) return;
    const box = c.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width, y = (e.clientY - box.top) / box.height;
    const pad = 0.015;
    const inside = (b: { x0: number; x1: number; y0: number; y1: number }) => x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad;
    const over = (r.captionAlpha > 0.25 && inside(r.captionBox)) || (r.labelAlpha > 0.25 && inside(r.labelBox));
    c.style.cursor = over ? 'text' : '';
    if (over && click) openInfo();
  };

  const toggle = useCallback(() => {
    const p = player.current;
    if (!p?.buffer || offline.current) return;
    if (p.playing) p.pause();
    else void p.play();
  }, []);

  const seekTo = useCallback((t: number) => { void player.current?.seek(t); }, []);

  // Controls step back while the song plays and nobody is touching anything.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setQuiet(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (player.current?.playing && !document.querySelector('dialog[open]')) setQuiet(true);
      }, 3500);
    };
    const key = (e: KeyboardEvent) => {
      wake();
      if (e.code === 'Space' && !(e.target as HTMLElement).closest('button, a, input, select, dialog, [role=slider]')) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', key);
    wake();
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', key);
    };
  }, [toggle, playing]);

  // ---- timeline -------------------------------------------------------------
  const scrub = (e: React.PointerEvent<HTMLDivElement>, force = false) => {
    const now = performance.now();
    if (!force && now - lastSeek.current < 70) return;
    lastSeek.current = now;
    const box = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    seekTo(f * (player.current?.duration ?? 0));
  };

  // ---- export ---------------------------------------------------------------
  const openExport = () => {
    player.current?.pause();
    setExp({ stage: 'options' });
    setExpProgress(0);
    exportDialog.current?.showModal();
  };

  const closeExport = () => {
    abort.current?.abort();
    setExp((prev) => {
      if (prev?.stage === 'done' && prev.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    exportDialog.current?.close();
  };

  const download = (url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const startExport = async () => {
    const s = songRef.current, r = renderer.current, p = player.current, canvas = canvasRef.current;
    if (!s || !r || !p || !canvas) return;
    const long = even((size * 16) / 9);
    const width = shape === 'landscape' ? long : size;
    const height = shape === 'portrait' ? long : size;
    const base = (s.artist ? `${s.artist} - ${s.title}` : s.title).replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'strings';
    const controller = new AbortController();
    abort.current = controller;
    const finish = (blob: Blob | null, name: string) => {
      const url = blob ? URL.createObjectURL(blob) : null;
      if (url) download(url, name);
      setExp({ stage: 'done', url, name });
    };
    const record = async () => {
      setExp({ stage: 'running', live: true });
      // Record at the chosen size and shape, at full resolution, from the song's own starting state.
      holdSize.current = true;
      const keep = { offset: r.centerOffset, compact: r.compact, calm: r.reducedMotion };
      r.reducedMotion = false;
      r.governorPaused = true;
      r.centerOffset = 0;
      r.compact = false;
      r.resize(width, height, true);
      r.setSafeTop(0);
      r.seed(s.analysis.seed);
      canvas.classList.add('exporting');
      try {
        const blob = await exportRealtime({ canvas, player: p, fps, signal: controller.signal, onProgress: setExpProgress });
        finish(blob, `${base} (Strings).${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
      } finally {
        holdSize.current = false;
        r.governorPaused = false;
        r.centerOffset = keep.offset;
        r.compact = keep.compact;
        r.reducedMotion = keep.calm;
        canvas.classList.remove('exporting');
        fit.current();
      }
    };
    try {
      if (!offlineExportAvailable()) {
        if (!realtimeExportAvailable()) throw new Error('This browser cannot make video files. Try a current version of Chrome, Edge, Safari or Firefox.');
        await record();
        return;
      }
      const name = `${base} (Strings).mp4`;
      let fileStream: FileSystemWritableFileStream | undefined;
      type Picker = (o: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
      const picker = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
      if (picker) {
        // Chrome and Edge: write the video straight to disk, so long songs do not fill memory.
        try {
          const handle = await picker.call(window, {
            suggestedName: name,
            types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
          });
          fileStream = await handle.createWritable();
        } catch (e) {
          if ((e as DOMException).name === 'AbortError') return; // picker closed, stay on the options
        }
      }
      setExp({ stage: 'running', live: false });
      offline.current = true;
      canvas.classList.add('exporting');
      try {
        const blob = await exportOffline({
          renderer: r, canvas, audio: s.audio, analysis: s.analysis,
          width, height, fps, signal: controller.signal, onProgress: setExpProgress, fileStream,
        });
        finish(blob, name);
      } catch (e) {
        if (!(e instanceof ExportUnsupportedError)) throw e;
        await fileStream?.abort().catch(() => {});
        offline.current = false;
        canvas.classList.remove('exporting');
        fit.current();
        if (!realtimeExportAvailable()) throw new Error('This device has no video encoder the browser can use.');
        await record();
      } finally {
        offline.current = false;
        canvas.classList.remove('exporting');
        fit.current();
      }
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') setExp(null);
      else setExp({ stage: 'error', message: (e as Error).message || 'The export stopped unexpectedly.' });
    } finally {
      abort.current = null;
    }
  };

  const a = song?.analysis;
  const ready = phase === 'ready' && song && a;

  return (
    <div
      ref={stageRef}
      className={`stage${quiet && ready ? ' quiet' : ''}${dragging ? ' dragging' : ''}${ready && frame === 'tall' ? ' tall' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f) void openFile(f);
      }}
    >
      <canvas
        ref={canvasRef}
        className="plate"
        aria-label="Light shaped by the music"
        role="img"
        onPointerMove={(e) => onCaption(e, false)}
        onPointerUp={(e) => onCaption(e, true)}
      />
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus,.mp4,.webm,.mov,.mkv"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void openFile(f);
        }}
      />

      {phase === 'idle' && (
        <main className="intro">
          <h1>Strings</h1>
          <p>
            Give it a song. Watch the sound itself move as waves of light, and keep it as a video.
          </p>
          <div className="actions">
            <button className="solid" onClick={() => fileRef.current?.click()}>Open a song or video</button>
            <button className="outline" onClick={() => void playDemo()}>Play the demo</button>
          </div>
          {error ? <p className="error" role="alert">{error}</p> : <p className="note">Your file stays on this device.</p>}
        </main>
      )}

      {phase === 'loading' && (
        <div className="loading" role="status">
          <p>{status}</p>
          <div className="meter"><div style={{ transform: `scaleX(${progress})` }} /></div>
        </div>
      )}

      {ready && (
        <>
          <header className="top chrome">
            <span className="mark">Strings</span>
            <nav className="tools">
              <button onClick={openExport}>Export video</button>
              <span className="designs" role="group" aria-label="Frame">
                <button aria-pressed={frame === 'screen'} onClick={() => chooseFrame('screen')} title="Fill the screen">Screen</button>
                <button aria-pressed={frame === 'tall'} onClick={() => chooseFrame('tall')} title="Phone frame for Reels, Shorts and TikTok">9:16</button>
              </span>
              <button onClick={() => fileRef.current?.click()}>Open a file</button>
              <button onClick={() => aboutDialog.current?.showModal()}>How it works</button>
              {canFullscreen && (
                <button
                  onClick={() => {
                    if (document.fullscreenElement) void document.exitFullscreen();
                    else void document.documentElement.requestFullscreen();
                  }}
                >
                  Full screen
                </button>
              )}
            </nav>
          </header>

          <footer className="bar chrome">
            {error && <p className="error" role="alert">{error}</p>}
            <div className="meta">
              <div className="who" key={`${song.title}\u0000${song.artist}`}>
                <h2>{song.title}</h2>
                {byline(song)
                  ? <p className="artist">{byline(song)}</p>
                  : <button className="edit" onClick={openInfo}>Add artist</button>}
                <button className="edit" onClick={openInfo} aria-label="Change the title and artist">Edit</button>
              </div>
              <dl>
                {/* Shown only when measured clearly: silence, noise or a lone tone have no key or steady beat. */}
                <div><dt>Key</dt><dd>{a.key.confidence >= 0.6 && (a.key.notes ?? 12) >= 3 ? a.key.name : 'no clear key'}</dd></div>
                <div><dt>Tempo</dt><dd>{a.tempoStrength >= 0.2 ? `${Math.round(a.bpm)} BPM` : 'no steady beat'}</dd></div>
                <div><dt>Now</dt><dd ref={designRef} className="design">{DESIGN_NAMES[renderer.current?.current ?? 'ribbons']}</dd></div>
                <div><dt>Figure</dt><dd>{a.fingerprint.slice(0, 4)} {a.fingerprint.slice(4, 8)}</dd></div>
              </dl>
            </div>
            <div className="transport">
              <button className="play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  {playing ? <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /> : <path d="M8 5l11 7-11 7z" />}
                </svg>
              </button>
              <span className="time" ref={nowRef}>0:00</span>
              <div
                ref={sliderRef}
                className="arc"
                role="slider"
                tabIndex={0}
                aria-label="Position in the song"
                aria-valuemin={0}
                aria-valuemax={Math.round(a.duration)}
                aria-valuenow={0}
                aria-valuetext="0:00"
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); scrub(e, true); }}
                onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e); }}
                onPointerUp={(e) => scrub(e, true)}
                onKeyDown={(e) => {
                  const t = player.current?.time ?? 0;
                  if (e.key === 'ArrowRight') seekTo(t + 5);
                  else if (e.key === 'ArrowLeft') seekTo(t - 5);
                  else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
                  else if (e.key === 'End') { e.preventDefault(); seekTo(Math.max(0, (player.current?.duration ?? 0) - 1)); }
                  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
                }}
              >
                <canvas ref={arcRef} className="arc-all" />
                <div ref={playedRef} className="arc-played"><canvas ref={arcPlayedRef} /></div>
                <div ref={headRef} className="arc-head" />
              </div>
              <span className="time">{clock(a.duration)}</span>
            </div>
          </footer>
        </>
      )}

      {dragging && <div className="drop">Drop the song to play it</div>}

      <dialog ref={infoDialog} className="info">
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            const s = songRef.current;
            if (s) {
              const next = { ...s, title: draft.title.trim() || s.title, artist: draft.artist.trim(), showCaption: draft.show };
              songRef.current = next;
              setSong(next);
              applyCaption(next);
            }
            infoDialog.current?.close();
          }}
        >
          <h3>Song</h3>
          <p>Read from the file where it says. Change or add anything; it is shown at the start of the picture and of the video.</p>
          <label>Song or sound name
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoComplete="off" />
          </label>
          <label>Artist
            <input value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} autoComplete="off" />
          </label>

          <label className="check">
            <input type="checkbox" checked={draft.show} onChange={(e) => setDraft({ ...draft, show: e.target.checked })} />
            Show the title and artist on the picture
          </label>
          <div className="actions">
            <button type="submit" className="solid">Save</button>
            <button type="button" className="outline" onClick={() => infoDialog.current?.close()}>Cancel</button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={exportDialog}
        onClose={() => {
          abort.current?.abort();
          setExp((prev) => {
            if (prev?.stage === 'done' && prev.url) URL.revokeObjectURL(prev.url);
            return null;
          });
        }}
      >
        {exp?.stage === 'options' && (
          <form method="dialog" onSubmit={(e) => { e.preventDefault(); void startExport(); }}>
            <h3>Export video</h3>
            <p>The whole song is drawn again from the start and saved as an MP4 video with its sound, exactly as long as the song. The pictures change with the song's sections, as when you watch it.</p>
            <label>Shape
              <select value={shape} onChange={(e) => setShape(e.target.value as Shape)}>
                <option value="landscape">Wide 16:9, YouTube and screens</option>
                <option value="portrait">Tall 9:16, Reels, Shorts, TikTok</option>
                <option value="square">Square 1:1, feed posts</option>
              </select>
            </label>
            {shape === 'portrait' && (
              <p className="note">
                {size === 1080 ? '1080 × 1920, the size Reels, Shorts and TikTok expect.' : `${size} × ${even((size * 16) / 9)}. Reels, Shorts and TikTok expect 1080 × 1920.`}
                {song && song.analysis.duration > SHORTS_LIMIT && ` This song is ${clock(song.analysis.duration)}; Reels and Shorts take up to 3:00.`}
              </p>
            )}
            <label>Sharpness
              <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
                <option value={540}>540p, small file</option>
                <option value={720}>720p</option>
                <option value={1080}>1080p</option>
                <option value={1440}>1440p</option>
                <option value={2160}>4K</option>
              </select>
            </label>
            <label>Smoothness
              <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                <option value={30}>30 frames a second</option>
                <option value={60}>60 frames a second</option>
              </select>
            </label>
            <div className="actions">
              <button type="submit" className="solid">Export video</button>
              <button type="button" className="outline" onClick={closeExport}>Cancel</button>
            </div>
          </form>
        )}
        {exp?.stage === 'running' && (
          <div role="status">
            <h3>{exp.live ? 'Recording as the song plays' : 'Exporting video'}</h3>
            <p>
              {exp.live
                ? 'This browser cannot encode video ahead of time, so the song is recorded once through. Keep this tab in front.'
                : 'Keep this tab in front. Browsers slow down hidden tabs.'}
            </p>
            <div className="meter"><div style={{ transform: `scaleX(${expProgress})` }} /></div>
            <p className="note">{Math.round(expProgress * 100)}%</p>
            <div className="actions"><button className="outline" onClick={closeExport}>Cancel export</button></div>
          </div>
        )}
        {exp?.stage === 'done' && (
          <div>
            <h3>Video exported</h3>
            <p>{exp.url ? `"${exp.name}" is in your downloads.` : `Saved as "${exp.name}".`}</p>
            <div className="actions">
              {exp.url && <a className="solid" href={exp.url} download={exp.name}>Download again</a>}
              <button className="outline" onClick={closeExport}>Close</button>
            </div>
          </div>
        )}
        {exp?.stage === 'error' && (
          <div>
            <h3>The video was not exported</h3>
            <p role="alert">{exp.message}</p>
            <div className="actions">
              <button className="solid" onClick={() => setExp({ stage: 'options' })}>Change settings</button>
              <button className="outline" onClick={closeExport}>Close</button>
            </div>
          </div>
        )}
      </dialog>

      <dialog ref={aboutDialog} className="about">
        <h3>How it works</h3>
        <p>
          Nothing here moves on its own. The song is measured first (its notes, the loudness of each pitch range,
          hits, tempo, key and how bright it sounds), and every line and colour comes from those measurements.
        </p>
        <h4>The picture changes with the song</h4>
        <p>
          The song is split where the music changes: each moment is compared with every other, and a boundary is
          placed where what follows differs most from what came before, a voice coming in included. Each part gets
          the picture that fits what it does. Each change lands on the beat where the music changes and spreads out
          from the centre as a wave front, as a new sound travels from its source, taking as long as the change in
          the music does.
        </p>
        <h4>Plate</h4>
        <p>
          Sand on a vibrating plate gathers where the plate stands still. Each note shakes the plate in the
          pattern whose frequency matches it, so low music draws broad patterns and high music fine ones; the notes
          sounding now are added together. A hit throws the sand up.
        </p>
        <h4>Ripple tank</h4>
        <p>
          Each note clearly sounding is a wave source in water, two to four of them. Higher notes make shorter
          waves. Where crests meet, they add up; where a crest meets a trough, they cancel, so a chord draws a
          different pattern from a single interval.
        </p>
        <h4>Membrane</h4>
        <p>
          A round drum skin. Each part of the spectrum drives one way the skin can vibrate, from broad bulges (bass)
          to many small ripples (treble). The lines are rings of the skin, pushed out where it bulges.
        </p>
        <h4>Ribbons and Rings</h4>
        <p>
          Ribbons: the middle is now and the edges are four seconds ago; each ribbon is a pitch range, bass at the
          bottom. Rings: one leaves the centre with each attack in the music (faint ones at the beat through sustained sound), keeping the colour and notes of its moment, and fades as it spreads, as a real wave does.
        </p>
        <h4>Faraday waves</h4>
        <p>
          A dish of liquid shaken at a frequency grows standing waves on its surface. Their wavelength follows the
          physics of water waves (gravity and surface tension), so lower music makes longer waves. The number of
          notes sounding sets the symmetry, as two-frequency experiments show: one note squares, two hexagons,
          three an eight-fold pattern, four or more a twelve-fold quasi-crystal. Crests catch the light.
        </p>
        <h4>Strings</h4>
        <p>
          One string for each note sounding, lowest on the left, each as long as a string tuned to that note would
          be. A plucked string vibrates as a sum of harmonics set by where it is plucked: near the end for a bright
          sound, near the middle for a mellow one. That point comes from this sound&apos;s brightness.
        </p>
        <h4>Where and how large</h4>
        <p>
          Louder parts are drawn larger, as a nearer source would look. The picture leans toward where the sound sits
          between the speakers and rises a little with high music, all gliding over a few seconds.
        </p>
        <h4>Colour and sky</h4>
        <p>
          A note&apos;s colour is its frequency raised by about forty octaves into visible light: C green, D blue,
          E violet, G red, A orange. The frequency is the one this recording actually plays: its tuning is measured
          (A at 432 Hz, 442 Hz, a tape running fast), so each recording&apos;s notes give their own light. Louder is more vivid, lower music deeper and higher music lighter. A bright
          timbre carries strong overtones (the fifth and the third above), so its notes take some of their light;
          a pure tone keeps its own. Noisy sound is less vivid. The room behind follows the harmony. Stars are
          coloured by temperature: brighter-sounding songs have hotter, bluer stars, and in clearly pitched music
          some take the notes&apos; light. A few larger motes are round for soft sound and pointed for sharp,
          bright sound, larger when the music is low. Everything drifts away from where the sound sits between the
          speakers, rises with rising pitch and falls with falling pitch, with a little inertia. Treble makes stars
          twinkle, bass lights the nebula, every hit sends a faint wave across the sky, and lines linger as long as
          the recording&apos;s own sound does.
        </p>
        <div className="actions"><button className="outline" onClick={() => aboutDialog.current?.close()}>Close</button></div>
      </dialog>
    </div>
  );
}
