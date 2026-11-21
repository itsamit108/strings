// Writes a short WAV from the demo piece, for testing the "open a file" path.
import { renderDemo } from '../lib/demo/synth';
import { writeFileSync } from 'fs';
const sr = 44100, { left, right } = renderDemo(sr);
const [start = '31', seconds = '7', out = '/tmp/clip.wav'] = process.argv.slice(2);
const from = Math.floor(+start * sr), n = Math.min(left.length - from, Math.floor(+seconds * sr));
const buf = Buffer.alloc(44 + n * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
for (let i = 0; i < n; i++) {
  buf.writeInt16LE(Math.round(left[from + i] * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(right[from + i] * 32767), 46 + i * 4);
}
writeFileSync(out, buf);
