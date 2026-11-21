# Nodal: music as waves of light

Open a song or a video and watch the sound move as waves of coloured light. Keep it as an MP4
video with the sound in it, exactly as long as the song. Two designs: Ribbons and Rings.
Next.js 16, TypeScript, WebGL2, installable as a PWA. Nothing is uploaded: decoding, analysis,
drawing and video export all run on the device.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build && npm start   # production build; the service worker (offline use) only runs here
```

Installing as an app and the service worker need HTTPS or `localhost`.

Checks:

```bash
npm run typecheck
npm run test:dsp       # renders the demo piece and prints tempo, key and modes
npm run test:shaders   # needs glslangValidator on the PATH
```

## What you see, and where it comes from

Both designs show the last four seconds of the song. Nothing moves on its own: every height,
brightness, shape and colour is a measurement of the sound.

### Ribbons

The middle of the screen is now. The sound travels out to both sides; the edges are four seconds ago.

| On screen | Measured from the sound |
| --- | --- |
| Four ribbons, bass at the bottom | The spectrum split into pitch ranges (40 Hz to 10 kHz, equal steps in pitch) |
| How high a ribbon rises at a point | How loud that pitch range was at that moment |
| Long waves below, short waves above | Wavelength follows pitch |
| The two edges of a ribbon | Two neighbouring pitch ranges; twenty lines are strung between them |
| How fast the waves travel | Loudness |
| Overall brightness, and a flash | Loudness, and onsets (hits) |
| Palette | The key of the song, leaning toward the notes sounding now |

### Rings

A ring leaves the centre twice every beat and travels outward, so the centre is now.

| On screen | Measured from the sound |
| --- | --- |
| How often a ring leaves | Tempo |
| Brightness of a ring | Loudness when it left |
| A bold ring | An onset (a hit) when it left |
| Colour of a ring | The strongest notes when it left (each note has its own hue, in rainbow order from C to B) |
| Shape of a ring | The twelve notes sit around the circle (circle of fifths); the ring bulges toward the notes that were sounding |

Code: measurements in `lib/analysis/dsp.ts` and `finalize.ts`; drawing in `lib/render/shaders.ts`
and `renderer.ts`.

### How the measurements are made

- Short-time Fourier transform (Hann window, 4096 samples, hop 1024), spread over all CPU cores.
- Loudness: RMS in dB, scaled to the song's own range. Onsets: spectral flux above its local
  average. Tempo: autocorrelation of the onset curve. Key: Krumhansl–Kessler profiles.
- Pitch ranges: band power with a +3 dB per octave tilt, each range scaled to its own loudest
  moments in the song, with level-meter smoothing (quick to rise, slow to fall).
- The same file always gives the same video.

### Honest simplifications

- The waves on a ribbon are not the raw waveform (that moves far too fast to see). Their height
  is the measured level; their length and speed are chosen to follow pitch and loudness.
- Ribbon levels are smoothed over about a third of a second so the picture stays calm, which
  means very fast notes blend together.
- Tempo and key are estimates. Key detection commonly confuses a key with its neighbour a fifth
  away (the built-in demo is written around D minor and reads as A minor). Rings leave at the
  tempo's rate but are not locked to the exact beat positions.
- The bulge of a ring toward its notes is kept gentle, because a strong bulge tore the rings. In
  practice the rings look close to round.
- The first screen shows slow waves that are not driven by sound.

## Using the device

- Analysis runs in a pool of Web Workers, one per CPU core.
- Drawing is per pixel on the GPU at the screen's full resolution and refresh rate, in a 16-bit
  float light buffer. If a device cannot hold its frame rate, the internal resolution steps down.
- WebGL2 is used, not WebGPU.

## Export

"Export video" simulates the whole song again at a fixed time step and sends each frame to the
hardware encoder through WebCodecs, muxed to MP4 (H.264 with AAC, or Opus where AAC encoding is
missing). Every frame is exact and it is not tied to real time. The video is exactly as long as the uploaded sound (to the nearest frame) and contains that sound. In Chrome and Edge the file is
written straight to disk. Browsers without WebCodecs record the canvas while the song plays once
(MP4 or WebM).

## PWA

`app/manifest.ts` (install, file handlers), `public/sw.js` (offline cache),
`components/PwaRegister.tsx`. Also used: Wake Lock, Media Session, Fullscreen, File System Access,
drag and drop, the launch queue for "Open with".

## Tested, and not

Tested in headless Chromium with software rendering: production build, the demo, opening a WAV,
phone and desktop layout, and a 720p export checked with ffprobe (H.264 video, Opus sound, video length equal to the source length).

Not tested: real GPUs and frame rates, Safari, Firefox, iOS, Android, the AAC path, the
write-to-disk path, the recording fallback, installing the PWA, files other than WAV, and long files.

## Not done

- A WebGPU path.
- Very long files are decoded fully into memory.
- Tests are scripts, not a test suite.
