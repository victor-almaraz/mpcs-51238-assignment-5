import { SignUp } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { AuthPage } from '@/src/ui/auth-page';

export const metadata = { title: 'Sign up' };

export default async function SignUpPage() {
  const { userId } = await auth();
  if (userId) redirect('/projects');
  return (
    <AuthPage title="Sign-Up">
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/projects" />
    </AuthPage>
  );
}
