import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/instrument-sans/wght.css';
import './globals.css';
import PwaRegister from '@/components/PwaRegister';

const DESCRIPTION =
  'Open a song or a video. Watch the sound itself move as waves of light, drawn from its physics, and keep it as a video. Nothing is uploaded.';

export const metadata: Metadata = {
  metadataBase: new URL('https://strings-coral.vercel.app'),
  title: 'Strings: music as waves of light',
  description: DESCRIPTION,
  // What a shared link shows in messengers and social apps.
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'Strings',
    title: 'Strings: music as waves of light',
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Coloured waves of light drawn from a song' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Strings: music as waves of light',
    description: DESCRIPTION,
    images: ['/og.png'],
  },
  applicationName: 'Strings',
  appleWebApp: { capable: true, title: 'Strings', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#06070b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Browser extensions often add classes or attributes here before the page loads; that is not a mismatch.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
