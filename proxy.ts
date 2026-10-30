import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Routing layer only; RLS is the security boundary (doc/auth.md).
const isPublic = createRouteMatcher([
  '/', '/listen', '/console', '/learn(.*)', '/try', '/sign-in(.*)', '/sign-up(.*)', '/dsl-sandbox.js',
]);

export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublic(req)) await auth.protect();
  },
  { signInUrl: '/sign-in', signUpUrl: '/sign-up' },
);

export const config = {
  matcher: ['/((?!_next|worklets|.*\\.(?:css|js|json|map|png|svg|ico|woff2?|txt|wasm)$).*)', '/(api|trpc)(.*)'],
};
