import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  const base: MetadataRoute.Manifest = {
    name: 'Nodal: music as waves of light',
    short_name: 'Nodal',
    description: 'Watch your song move as waves of light. Keep it as a video.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#06070b',
    theme_color: '#06070b',
    categories: ['music', 'entertainment'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  // Lets the installed app appear under "Open with" for sound and video files.
  return {
    ...base,
    file_handlers: [
      {
        action: '/',
        accept: {
          'audio/*': ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus'],
          'video/*': ['.mp4', '.webm', '.mov', '.mkv'],
        },
      },
    ],
  } as MetadataRoute.Manifest;
}
