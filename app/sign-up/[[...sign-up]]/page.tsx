import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4">
      <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/projects" />
    </main>
  );
}
