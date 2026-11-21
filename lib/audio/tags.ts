/**
 * Song title and artist: from the file's own tags (ID3, MP4/iTunes, Vorbis, FLAC, RIFF INFO, APE),
 * else from a file name like "Artist - Title".
 */
export interface SongInfo { title: string; artist: string; /** seconds, when the file's header says */ duration?: number }

/** Cleans a file name: drops the extension and common download clutter. */
function fromFileName(name: string): SongInfo {
  let base = name.replace(/\.[^.]+$/, '');
  base = base
    .replace(/[_]+/g, ' ')
    .replace(/\s*[[(](official|lyrics?|audio|video|hd|hq|4k|music video|visuali[sz]er|remaster(ed)?)[^\])]*[\])]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { title: base, artist: '' };
}

export async function readSongInfo(file: File): Promise<SongInfo> {
  const guess = fromFileName(file.name);
  try {
    const { parseBlob } = await import('music-metadata');
    const meta = await parseBlob(file, { skipCovers: true, duration: false });
    const title = meta.common.title?.trim();
    // The performer if tagged, else the album artist, else the composer.
    const artist = (meta.common.artist ?? meta.common.albumartist ?? meta.common.artists?.join(', ') ?? meta.common.composer?.join(', '))?.trim();
    const duration = meta.format.duration && Number.isFinite(meta.format.duration) ? meta.format.duration : undefined;
    return { title: title || guess.title, artist: artist || (title ? '' : guess.artist), duration };
  } catch {
    return guess;
  }
}
