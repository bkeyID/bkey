import { auth, signIn, signOut } from '../auth';

export default async function Home() {
  const session = await auth();
  if (!session?.user) {
    return (
      <main>
        <h1>Login with bkey — quickstart</h1>
        <p>No password. Approve with your face on your phone.</p>
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
          await signOut();
        }}
      >
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
