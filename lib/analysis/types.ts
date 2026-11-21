/** Eight pitch ranges, each a little under an octave wide, from deep bass to air. */
export const BAND_COUNT = 8;
export const BAND_LOW_HZ = 40;
export const BAND_HIGH_HZ = 10000;

export interface ChunkFeatures {
  frameStart: number;
  frames: number;
  rms: Float32Array;
  flux: Float32Array;
  centroid: Float32Array;
  /** frames × 12, power per pitch class (0 = C) */
  chroma: Float32Array;
  /** frames × BAND_COUNT, amplitude in each pitch range, low to high */
  bands: Float32Array;
}

export interface AnalysisParams {
  sampleRate: number;
  fftSize: number;
  hop: number;
  totalFrames: number;
}

export interface KeyEstimate {
  tonic: number; // 0 = C
  minor: boolean;
  name: string;
  confidence: number;
}

export interface Analysis extends AnalysisParams {
  duration: number;
  /** 0..1 loudness, scaled to this song's own dynamic range */
  loud: Float32Array;
  /** 0..1.5 onset strength (sudden new energy) */
  onset: Float32Array;
  /** 0..1 spectral brightness */
  bright: Float32Array;
  /** frames × 12, each frame sums to 1 */
  chroma: Float32Array;
  /** frames × BAND_COUNT, 0..1, each pitch range scaled to its own loudest moments in this song */
  bands: Float32Array;
  bpm: number;
  beatPeriod: number;
  /** how strongly the onsets repeat at the tempo, 0..1 (low: no steady beat, so the tempo is not shown) */
  tempoStrength: number;
  key: KeyEstimate;
  /** 16 hex characters derived from the song's measured features */
  fingerprint: string;
  seed: number;
  /** loudness outline of the whole song, for the timeline */
  arc: Float32Array;
  /** pitch-colour angle (0..1) of each timeline point */
  arcHue: Float32Array;
}

export type WorkerRequest =
  | {
      type: 'analyze';
      id: number;
      samples: Float32Array;
      /** index in the song of samples[0] */
      offset: number;
      frameStart: number;
      frameEnd: number;
      params: AnalysisParams;
    }
  | { type: 'demo'; id: number; sampleRate: number };

export type WorkerResponse =
  | { type: 'analyze'; id: number; features: ChunkFeatures }
  | { type: 'demo'; id: number; left: Float32Array; right: Float32Array };
