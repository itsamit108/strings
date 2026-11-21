/**
 * Pulls the sound track out of an MP4/M4A/MOV, including fragmented MP4s (moof/mdat), which
 * `decodeAudioData` refuses in Chromium. Returns the coded frames so they can be decoded another way.
 */

export interface Mp4AudioTrack {
  codec: 'aac' | 'opus';
  /** AudioSpecificConfig (AAC) or null. */
  config: Uint8Array | null;
  sampleRate: number;
  channels: number;
  timescale: number;
  frames: Uint8Array[];
}

interface Box { type: string; start: number; body: number; end: number }

function* boxes(v: DataView, from: number, to: number): Generator<Box> {
  let o = from;
  while (o + 8 <= to) {
    let size = v.getUint32(o);
    const type = String.fromCharCode(v.getUint8(o + 4), v.getUint8(o + 5), v.getUint8(o + 6), v.getUint8(o + 7));
    let body = o + 8;
    if (size === 1) {
      size = Number(v.getBigUint64(o + 8));
      body = o + 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < 8 || o + size > to) {
      // A truncated last box (common in partial downloads): read what is there.
      yield { type, start: o, body, end: to };
      return;
    }
    yield { type, start: o, body, end: o + size };
    o += size;
  }
}

function child(v: DataView, b: Box, type: string): Box | undefined {
  for (const c of boxes(v, b.body, b.end)) if (c.type === type) return c;
  return undefined;
}

function path(v: DataView, b: Box, ...types: string[]): Box | undefined {
  let cur: Box | undefined = b;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(v, cur, t);
  }
  return cur;
}

/** Reads an MPEG-4 descriptor length (1–4 bytes, 7 bits each). */
function descLen(v: DataView, o: number): [number, number] {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = v.getUint8(o++);
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return [len, o];
}

/** Finds the DecoderSpecificInfo (tag 5) inside an esds box. */
function esdsConfig(v: DataView, esds: Box): Uint8Array | null {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let o = esds.body + 4; // version + flags
  while (o < esds.end) {
    const tag = v.getUint8(o);
    const [len, next] = descLen(v, o + 1);
    if (tag === 0x03) {
      // ES_Descriptor: ES_ID(2) flags(1) [+ optional fields]
      const flags = v.getUint8(next + 2);
      let p = next + 3;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + v.getUint8(p);
      if (flags & 0x20) p += 2;
      o = p;
    } else if (tag === 0x04) {
      o = next + 13; // DecoderConfigDescriptor fixed part
    } else if (tag === 0x05) {
      return bytes.slice(next, next + len);
    } else {
      o = next + len;
    }
  }
  return null;
}

interface TrackInfo {
  id: number;
  timescale: number;
  codec: 'aac' | 'opus';
  config: Uint8Array | null;
  sampleRate: number;
  channels: number;
  stbl: Box;
}

function audioTrack(v: DataView, moov: Box): TrackInfo | null {
  for (const trak of boxes(v, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = path(v, trak, 'mdia', 'hdlr');
    if (!hdlr) continue;
    const handler = String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + hdlr.body + 8, 4));
    if (handler !== 'soun') continue;
    const tkhd = child(v, trak, 'tkhd');
    const mdhd = path(v, trak, 'mdia', 'mdhd');
    const stbl = path(v, trak, 'mdia', 'minf', 'stbl');
    const stsd = stbl && child(v, stbl, 'stsd');
    if (!tkhd || !mdhd || !stbl || !stsd) continue;
    const id = v.getUint32(tkhd.body + (v.getUint8(tkhd.body) === 1 ? 20 : 12));
    const timescale = v.getUint32(mdhd.body + (v.getUint8(mdhd.body) === 1 ? 20 : 12));
    // First sample entry: 8 bytes of stsd header, then the entry box.
    const entry = boxes(v, stsd.body + 8, stsd.end).next().value as Box | undefined;
    if (!entry) continue;
    const channels = v.getUint16(entry.body + 16);
    const sampleRate = v.getUint32(entry.body + 24) >>> 16;
    const version = v.getUint16(entry.body + 8);
    // QuickTime sound description v1/v2 carry extra fields before the child boxes.
    const kids = entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    if (entry.type === 'mp4a') {
      let config: Uint8Array | null = null;
      for (const c of boxes(v, kids, entry.end)) {
        if (c.type === 'esds') config = esdsConfig(v, c);
        if (c.type === 'wave') {
          const esds = child(v, c, 'esds');
          if (esds) config = esdsConfig(v, esds);
        }
      }
      return { id, timescale, codec: 'aac', config, sampleRate, channels, stbl };
    }
    if (entry.type === 'Opus') return { id, timescale, codec: 'opus', config: null, sampleRate: 48000, channels, stbl };
  }
  return null;
}

/** Samples listed in the moov sample table (ordinary, non-fragmented files). */
function tableFrames(v: DataView, bytes: Uint8Array, stbl: Box): Uint8Array[] {
  const stsz = child(v, stbl, 'stsz');
  const stsc = child(v, stbl, 'stsc');
  const stco = child(v, stbl, 'stco') ?? child(v, stbl, 'co64');
  if (!stsz || !stsc || !stco) return [];
  const fixed = v.getUint32(stsz.body + 4);
  const count = v.getUint32(stsz.body + 8);
  if (!count) return [];
  const size = (i: number) => fixed || v.getUint32(stsz.body + 12 + i * 4);
  const chunks = v.getUint32(stco.body + 4);
  const wide = stco.type === 'co64';
  const chunkOffset = (i: number) => wide ? Number(v.getBigUint64(stco.body + 8 + i * 8)) : v.getUint32(stco.body + 8 + i * 4);
  const runs = v.getUint32(stsc.body + 4);
  const frames: Uint8Array[] = [];
  let sample = 0;
  for (let r = 0; r < runs && sample < count; r++) {
    const first = v.getUint32(stsc.body + 8 + r * 12) - 1;
    const per = v.getUint32(stsc.body + 12 + r * 12);
    const last = r + 1 < runs ? v.getUint32(stsc.body + 8 + (r + 1) * 12) - 1 : chunks;
    for (let c = first; c < last && sample < count; c++) {
      let o = chunkOffset(c);
      for (let k = 0; k < per && sample < count; k++, sample++) {
        const s = size(sample);
        if (o + s > bytes.length) return frames;
        frames.push(bytes.subarray(o, o + s));
        o += s;
      }
    }
  }
  return frames;
}

/** Samples in movie fragments (moof + mdat). */
function fragmentFrames(v: DataView, bytes: Uint8Array, trackId: number, moov: Box, top: Box[]): Uint8Array[] {
  let defaultSize = 0;
  const mvex = child(v, moov, 'mvex');
  if (mvex) {
    for (const trex of boxes(v, mvex.body, mvex.end)) {
      if (trex.type === 'trex' && v.getUint32(trex.body + 4) === trackId) defaultSize = v.getUint32(trex.body + 16);
    }
  }
  const frames: Uint8Array[] = [];
  for (const moof of top) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(v, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = child(v, traf, 'tfhd');
      if (!tfhd || v.getUint32(tfhd.body + 4) !== trackId) continue;
      const tf = v.getUint32(tfhd.body) & 0xffffff;
      let p = tfhd.body + 8;
      let base = moof.start; // default-base-is-moof, and the usual case without a base offset
      if (tf & 0x1) { base = Number(v.getBigUint64(p)); p += 8; }
      if (tf & 0x2) p += 4;
      if (tf & 0x8) p += 4;
      let size = defaultSize;
      if (tf & 0x10) size = v.getUint32(p);
      let next = base;
      for (const trun of boxes(v, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue;
        const flags = v.getUint32(trun.body) & 0xffffff;
        const n = v.getUint32(trun.body + 4);
        let q = trun.body + 8;
        let o = next;
        if (flags & 0x1) { o = base + v.getInt32(q); q += 4; }
        if (flags & 0x4) q += 4;
        for (let i = 0; i < n; i++) {
          if (flags & 0x100) q += 4;
          let s = size;
          if (flags & 0x200) { s = v.getUint32(q); q += 4; }
          if (flags & 0x400) q += 4;
          if (flags & 0x800) q += 4;
          if (o + s > bytes.length) return frames;
          frames.push(bytes.subarray(o, o + s));
          o += s;
        }
        next = o;
      }
    }
  }
  return frames;
}

/** True when the bytes look like an ISO media file (MP4, M4A, MOV, 3GP). */
export function isMp4(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const t = String.fromCharCode(...new Uint8Array(data, 4, 4));
  return t === 'ftyp' || t === 'moov' || t === 'styp' || t === 'free' || t === 'wide' || t === 'mdat';
}

export function readMp4Audio(data: ArrayBuffer): Mp4AudioTrack | null {
  const v = new DataView(data);
  const bytes = new Uint8Array(data);
  const top = [...boxes(v, 0, data.byteLength)];
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;
  const t = audioTrack(v, moov);
  if (!t) return null;
  const frames = [...tableFrames(v, bytes, t.stbl), ...fragmentFrames(v, bytes, t.id, moov, top)];
  if (!frames.length) return null;
  return { codec: t.codec, config: t.config, sampleRate: t.sampleRate, channels: t.channels, timescale: t.timescale, frames };
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Wraps raw AAC frames in ADTS headers, a stream every browser's decodeAudioData accepts.
 * Returns null when the config can't be expressed in ADTS.
 */
export function toAdts(track: Mp4AudioTrack): ArrayBuffer | null {
  if (track.codec !== 'aac') return null;
  let aot = 2;
  let rateIndex = ADTS_RATES.indexOf(track.sampleRate);
  let channels = track.channels;
  const c = track.config;
  if (c && c.length >= 2) {
    aot = c[0] >> 3;
    rateIndex = ((c[0] & 7) << 1) | (c[1] >> 7);
    channels = (c[1] >> 3) & 0xf;
    if (aot === 31 || rateIndex === 15) return null;
    // HE-AAC (SBR / PS): ADTS carries the core AAC-LC stream; decoders find the SBR data implicitly.
    if (aot === 5 || aot === 29) aot = 2;
  }
  if (aot < 1 || aot > 4 || rateIndex < 0 || rateIndex > 12 || channels < 1 || channels > 7) return null;
  const total = track.frames.reduce((n, f) => n + f.length + 7, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of track.frames) {
    const len = f.length + 7;
    out[o] = 0xff;
    out[o + 1] = 0xf1; // MPEG-4, layer 0, no CRC
    out[o + 2] = ((aot - 1) << 6) | (rateIndex << 2) | (channels >> 2);
    out[o + 3] = ((channels & 3) << 6) | (len >> 11);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 7) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    out.set(f, o + 7);
    o += len;
  }
  return out.buffer;
}

/** Decodes the frames with WebCodecs (used when ADTS isn't possible or is refused). */
export async function decodeWithWebCodecs(track: Mp4AudioTrack, ctx: BaseAudioContext): Promise<AudioBuffer> {
  if (typeof AudioDecoder === 'undefined') throw new Error('WebCodecs is not available');
  const aot = track.config && track.config.length ? track.config[0] >> 3 : 2;
  const config: AudioDecoderConfig = {
    codec: track.codec === 'opus' ? 'opus' : `mp4a.40.${aot}`,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    ...(track.config ? { description: track.config } : {}),
  };
  if (!(await AudioDecoder.isConfigSupported(config)).supported) throw new Error(`${config.codec} cannot be decoded here`);
  const chunks: Float32Array[][] = [];
  let rate = track.sampleRate;
  let channels = 0;
  let error: unknown = null;
  const decoder = new AudioDecoder({
    output: (d) => {
      rate = d.sampleRate;
      channels = Math.max(channels, d.numberOfChannels);
      const planes: Float32Array[] = [];
      for (let ch = 0; ch < d.numberOfChannels; ch++) {
        const plane = new Float32Array(d.numberOfFrames);
        d.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        planes.push(plane);
      }
      chunks.push(planes);
      d.close();
    },
    error: (e) => { error = e; },
  });
  decoder.configure(config);
  const step = track.codec === 'opus' ? 960 : 1024;
  const usPerFrame = (step / track.sampleRate) * 1e6;
  track.frames.forEach((f, i) => decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * usPerFrame), data: f })));
  await decoder.flush();
  decoder.close();
  if (error) throw error;
  const length = chunks.reduce((n, c) => n + c[0].length, 0);
  if (!length || !channels) throw new Error('no sound decoded');
  const buffer = ctx.createBuffer(channels, length, rate);
  for (let ch = 0; ch < channels; ch++) {
    const dest = buffer.getChannelData(ch);
    let o = 0;
    for (const c of chunks) {
      dest.set(c[Math.min(ch, c.length - 1)], o);
      o += c[0].length;
    }
  }
  return buffer;
}
