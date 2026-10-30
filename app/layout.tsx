import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sphärenmusik', template: '%s · Sphärenmusik' },
  description: 'A generative audio-visual piece driven by live space data.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up">
      <html lang="en">
        <body className="min-h-full">{children}</body>
      </html>
    </ClerkProvider>
  );
}
