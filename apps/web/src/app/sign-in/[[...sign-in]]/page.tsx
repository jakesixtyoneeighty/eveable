import { SignIn } from "@clerk/nextjs";
export default function Page() {
  return (
    <main className="auth-page">
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
    </main>
  );
}
