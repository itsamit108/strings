import * as S from '../lib/render/shaders';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
let ok = true;
for (const [name, src] of Object.entries(S)) {
  if (typeof src !== "string" || !src.startsWith("#version")) continue;
  const stage = name.endsWith('_VS') ? 'vert' : 'frag';
  const file = `/tmp/${name}.${stage}`;
  writeFileSync(file, src);
  try { execSync(`glslangValidator ${file}`, { stdio: 'pipe' }); console.log('ok  ', name); }
  catch (e: any) { ok = false; console.log('FAIL', name, '\n', e.stdout?.toString()); }
}
process.exit(ok ? 0 : 1);
