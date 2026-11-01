import { SignIn } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { AuthPage } from '@/src/ui/auth-page';

export const metadata = { title: 'Sign in' };

export default async function SignInPage() {
  const { userId } = await auth();
  if (userId) redirect('/projects');
  return (
    <AuthPage title="Sign-In">
      <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/projects" />
    </AuthPage>
  );
}
