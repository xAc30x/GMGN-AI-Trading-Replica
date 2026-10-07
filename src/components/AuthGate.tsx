import { useEffect, useState, type ReactNode } from 'react';
import { SIGNED_OUT_EVENT, fetchCurrentUser, signOut, takeSignInError, type AuthUser } from '../auth';
import { AuthPage } from './AuthPage';

export interface Account {
  email: string;
  onSignOut: () => void;
}

type GateState =
  | { kind: 'checking' }
  | { kind: 'signed-out'; notice?: string }
  | { kind: 'signed-in'; user: AuthUser };

/** Shows the sign-in page until the server confirms a session, then renders the app. */
export function AuthGate({ children }: { children: (account: Account) => ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;
    const signInError = takeSignInError();
    fetchCurrentUser()
      .then((user) => {
        if (!cancelled) setState(user ? { kind: 'signed-in', user } : { kind: 'signed-out', notice: signInError || undefined });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'signed-out', notice: 'Could not reach the server. Check that it is running, then try again.' });
      });
    const onSignedOut = () => setState({ kind: 'signed-out', notice: 'Your session ended. Please sign in again.' });
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => {
      cancelled = true;
      window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
    };
  }, []);

  if (state.kind === 'checking') {
    return (
      <main className="auth-page">
        <p className="auth-note" role="status">Checking sign-in…</p>
      </main>
    );
  }

  if (state.kind === 'signed-out') {
    return <AuthPage notice={state.notice} onSignedIn={(user) => setState({ kind: 'signed-in', user })} />;
  }

  const onSignOut = () => {
    signOut()
      .then(() => setState({ kind: 'signed-out' }))
      .catch((e: unknown) => {
        window.alert(`Sign-out failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  };

  return children({ email: state.user.email, onSignOut });
}
