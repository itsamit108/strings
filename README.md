# Strings: music as waves of light

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

Nothing moves on its own: every line, colour and motion is a measurement of the sound.

### The picture changes with the song

The song is split where the music changes, using Foote's audio novelty (ICME 2000): half-second blocks
described by their notes (chroma), pitch-range levels, loudness, onsets, timbral brightness and the share of
energy in the voice range are compared with every other block, and a Gaussian checkerboard kernel slid along
that self-similarity matrix scores how different what follows is from what came before. Peaks are the
boundaries (at least 8 s apart; parts longer than 32 s are cut again at their own strongest change). Each
part gets the design that best shows what it does, scored against the rest of the same song, never the same
design twice in a row; designs cross-fade over about four beats. Code: `lib/analysis/sections.ts`.

| Design | Physics | Chosen when |
| --- | --- | --- |
| Plate | Chladni figure: sand on the nodal lines of a square plate, mode cos(nπx)cos(mπy) − cos(mπx)cos(nπy). Each note drives the mode whose frequency (∝ n² + m²) matches it; the notes sounding are summed. Hits throw the sand. | one note dominates and holds |
| Two-note figure | Lissajous / harmonograph: the two strongest notes drive x and y at their just ratio (fifth 3:2, third 5:4…). Equal temperament is slightly off that ratio, so the figure turns at exactly the beat frequency. | two notes sound together, few hits |
| Ripple tank | Two point sources, one per strongest note; one medium, so wavelength ∝ 1/frequency; amplitude ∝ 1/√r; crests of the summed wave. | two notes, weight in the bass |
| Membrane | Round drum skin: modes J_n(j_n1·r)·cos(n(θ − φ)), mode n driven by pitch range n; the lines are contours of the displaced skin. | energy in the voice range |
| Rings | A ring leaves the centre every half beat and keeps the loudness, hits and notes of its moment. | many onsets |
| Ribbons | Pitch ranges as ribbons; the middle is now, the edges four seconds ago. | energy across the whole spectrum |

`?design=plate` (or `figure`, `ripples`, `membrane`, `rings`, `ribbons`) shows one design on its own, for checking.

### Bass and voice

- Bass: for the same loudness, a low sound moves the air farther than a high one (displacement ∝ 1/f),
  so bass makes every design swell (up to about 13%). A bass hit, a fast rise in the two lowest pitch
  ranges, gives a short swell and glow, throws the plate's sand, strengthens the ripple tank's lower
  source, drives the drum skin's whole-skin (fundamental) mode and sends a wave across the sky.
- Voice range (pitch ranges 4–6, about 315 Hz – 2.5 kHz, where voices carry their formants): when strong,
  lines glow brighter and wider, the drum skin's middle modes swell and the nebula warms; a voice coming
  in blooms once. Without separating the singer from the music this is the voice range, not a voice detector.

### Colour

- Hue: a note's frequency raised by octaves (×2, about 40 times) into the octave of visible light,
  400–800 THz, then the colour of that wavelength (CIE 1931 fit of Wyman et al. 2013). The gap past violet
  is closed with the purples, as on Newton's circle. C green, D blue, E violet, G red, A orange.
- Louder → more saturated (Anikin & Johansson 2019); higher → lighter (Marks 1974); brighter timbre
  (spectral centroid) → lighter (Schubert & Wolfe 2006); fast and major → lighter, more vivid, yellower;
  slow and minor → darker, bluer (Palmer, Schloss et al., PNAS 2013).
- Colours sit near each hue's most vivid in-gamut point (OKLCH), never clipped.

### Sky

Same song, same sky (seeded by the song's fingerprint). Star colour is blackbody temperature, shifted hotter
for brighter-sounding songs (spectral centroid ↔ colour temperature); busier music has more stars; treble sets
the twinkle; bass lights the nebula, whose colour follows the notes; the clouds flow and the sky turns with
tempo and loudness; each clear onset sends a faint wave front out from the centre.

### Title and artist

Read from the file's tags (ID3, MP4, Vorbis, FLAC, RIFF; `music-metadata`), else from a file name like
"Artist - Title". "Edit", or a click on the title while it shows on the picture, changes them. They rise into
the picture over the first seconds and fade by eight seconds, in the exported video too.

### How the measurements are made

- Short-time Fourier transform (Hann window, 4096 samples, hop 1024), spread over all CPU cores.
- Loudness: RMS in dB, scaled to the song's own range. Onsets: spectral flux above its local
  average. Tempo: autocorrelation of the onset curve. Key: Krumhansl–Kessler profiles.
- Pitch ranges: band power with a +3 dB per octave tilt, each range scaled to its own loudest
  moments in the song, with level-meter smoothing (quick to rise, slow to fall).
- Key and tempo are shown only when measured clearly (key profile match ≥ 0.6; onsets repeating at the
  tempo with ≥ 0.2 of their variance). Silence, noise or a lone tone show "no clear key" / "no steady beat".
- Moving frequencies are shown eight octaves down (÷256): ripple-tank waves at the notes' own
  frequencies, drum-skin modes at j_n1/j_01 times the key note (÷512); a hit's wave reaches the picture's
  edge in one bar.
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
