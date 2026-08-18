import { auth, signIn, signOut } from '../auth';
import { bkeyEndSessionUrl, getIdToken } from '../lib/bkey';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  const { error } = await searchParams;

  if (!session?.user) {
    return (
      <main>
        <h1>Login with bkey — quickstart</h1>
        <p>No password. Approve with your face on your phone.</p>
        {/* Auth.js redirects failures back here with ?error=… — surface it.
            Without this a failed callback renders as a blank signed-out page
            with no indication anything went wrong. */}
        {error && (
          <p style={{ borderLeft: '3px solid crimson', paddingLeft: 12 }}>
            Sign-in failed: <code>{error}</code> — see the server logs for the
            underlying OIDC error.
          </p>
        )}
        <form
          action={async () => {
            'use server';
            await signIn('bkey');
          }}
        >
          <button type="submit" style={{ padding: '12px 20px', fontSize: 16 }}>
            Sign in with bkey
          </button>
        </form>
      </main>
    );
  }
  return (
    <main>
      <h1>Signed in ✓</h1>
      <p>
        Your bkey ID: <code>{session.user.id}</code>
      </p>
      <p>That pseudonymous DID is the only thing bkey shared — no name, no email.</p>
      <form
        action={async () => {
          'use server';
          // Sign out of this app AND of bkey. Clearing only the local cookie
          // leaves the bkey session alive, so the next sign-in can complete
          // with no biometric prompt — see lib/bkey.ts.
          // Build the bkey end-session URL first, but never let it prevent the
          // local sign-out: discovery can fail, and endSessionUrl throws
          // `end_session_unavailable` where the endpoint isn't advertised. If
          // that threw here the action would abort and the user would not be
          // signed out of this app either.
          let redirectTo: string | undefined;
          const idToken = await getIdToken();
          if (idToken) {
            try {
              redirectTo = await bkeyEndSessionUrl(idToken);
            } catch (err) {
              console.warn('[bkey] end_session unavailable, signing out locally only:', err);
            }
          } else {
            console.warn(
              '[bkey] no id_token on the session — signing out locally only; ' +
                'the bkey session stays active. Check APP_URL matches the origin ' +
                'this app is served on.',
            );
          }
          await signOut(redirectTo ? { redirectTo } : undefined);
        }}
      >
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
