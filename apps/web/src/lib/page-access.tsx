import { auth } from "@clerk/nextjs/server";
import { requireMember } from "@eveable/core/access";
import { AppError } from "@eveable/core/errors";
import Link from "next/link";
import { Brand } from "@/components/home";
export async function accessScreen() {
  if (
    !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    !process.env.DATABASE_URL
  )
    return (
      <main className="access-page">
        <Brand />
        <span className="eyebrow">WORKSPACE SETUP</span>
        <h1>
          A place for
          <br />
          your next idea.
        </h1>
        <p>Connect Clerk and the project database to open your workspace.</p>
        <p className="muted">
          The setup guide is in the repository README. No account or project
          data is available until configuration is complete.
        </p>
      </main>
    );
  const { userId } = await auth();
  if (!userId)
    return (
      <main className="access-page">
        <Brand />
        <span className="eyebrow">YOUR PRIVATE BUILDING STUDIO</span>
        <h1>
          From a thought
          <br />
          to a <em>working thing.</em>
        </h1>
        <p>Design, build, and publish websites in one focused workspace.</p>
        <Link className="primary-button" href="/sign-in">
          Sign in to Eveable ↗
        </Link>
        <p className="muted">Available to invited members.</p>
      </main>
    );
  try {
    await requireMember(userId);
  } catch (e) {
    if (e instanceof AppError && e.status === 403)
      return (
        <main className="access-page">
          <Brand />
          <h1>
            An invitation
            <br />
            opens the door.
          </h1>
          <p>
            Your account is signed in, but it does not have active Eveable
            membership. Ask the workspace owner to grant access.
          </p>
        </main>
      );
    throw e;
  }
  return null;
}
