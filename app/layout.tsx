import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sphärenmusik', template: '%s · Sphärenmusik' },
  description: 'A generative audio-visual piece driven by live space data.',
};

/** Clerk's forms in the black-and-white system (doc/ui.md, Design system). */
const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#ffffff', colorPrimaryForeground: '#000000', colorBackground: '#000000', colorForeground: '#ffffff',
    colorMuted: '#000000', colorMutedForeground: '#ffffff', colorInput: '#000000', colorInputForeground: '#ffffff',
    colorBorder: '#ffffff', colorNeutral: '#ffffff', colorRing: '#ffffff', colorShadow: 'transparent',
    colorDanger: '#ffffff', colorSuccess: '#ffffff', colorWarning: '#ffffff',
    borderRadius: '4px', fontFamily: 'inherit',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up" appearance={CLERK_APPEARANCE}>
      <html lang="en">
        <body className="min-h-full">{children}</body>
      </html>
    </ClerkProvider>
  );
}
