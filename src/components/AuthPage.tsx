import { useEffect, useState, type FormEvent } from 'react';
import {
  PASSWORD_MIN_LENGTH,
  fetchProviders,
  signIn,
  signUp,
  startGoogleSignIn,
  type AuthUser,
  type SignInProviders,
} from '../auth';

type AuthMode = 'signin' | 'signup';

interface Props {
  onSignedIn: (user: AuthUser) => void;
  /** Shown above the form, for example when the server could not be reached or the session ended. */
  notice?: string;
}

const TABS: { id: AuthMode; label: string }[] = [
  { id: 'signin', label: 'Sign in' },
  { id: 'signup', label: 'Sign up' },
];

/** Starting page: sign in or sign up before the dashboard is shown. */
export function AuthPage({ onSignedIn, notice }: Props) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [providers, setProviders] = useState<SignInProviders>({ google: false, apple: false });

  useEffect(() => {
    let cancelled = false;
    void fetchProviders().then((p) => {
      if (!cancelled) setProviders(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setPassword('');
    setConfirm('');
    setError('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'signup') {
      if (password.length < PASSWORD_MIN_LENGTH) {
        setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
        return;
      }
      if (password !== confirm) {
        setError('The two passwords do not match');
        return;
      }
    }
    setBusy(true);
    try {
      const user = mode === 'signin' ? await signIn(email, password) : await signUp(email, password);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const isSignUp = mode === 'signup';
  const verb = isSignUp ? 'Sign up' : 'Sign in';

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <div className="brand-icon" aria-hidden>
            AI
          </div>
          <div>
            <h1 id="auth-title">AI Trader</h1>
            <p>Sign in to open your trading dashboard.</p>
          </div>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="Sign in or sign up">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`auth-tab-${t.id}`}
              aria-selected={mode === t.id}
              aria-controls="auth-panel"
              className={`tab ${mode === t.id ? 'active' : ''}`}
              onClick={() => switchMode(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div id="auth-panel" role="tabpanel" aria-labelledby={`auth-tab-${mode}`}>
          {notice && <div className="warn-box">{notice}</div>}

          <form onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                type="password"
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {isSignUp && <div className="help">At least {PASSWORD_MIN_LENGTH} characters.</div>}
            </div>
            {isSignUp && (
              <div className="field">
                <label htmlFor="auth-confirm">Confirm password</label>
                <input
                  id="auth-confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            )}

            {error && (
              <div className="auth-error" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="btn-primary auth-submit" disabled={busy}>
              {busy ? `${verb}…` : `${verb} with email`}
            </button>
          </form>

          <div className="auth-divider" aria-hidden>
            <span>or</span>
          </div>

          <div className="auth-providers">
            <button
              type="button"
              className="btn-ghost"
              disabled={!providers.google || busy}
              aria-describedby={providers.google ? undefined : 'auth-providers-note'}
              onClick={() => {
                setBusy(true);
                startGoogleSignIn();
              }}
            >
              Continue with Google
            </button>
            <button type="button" className="btn-ghost" disabled aria-describedby="auth-providers-note">
              Continue with Apple
            </button>
          </div>
          <p id="auth-providers-note" className="auth-note">
            {providers.google
              ? 'Apple sign-in is not set up on this server yet.'
              : 'Google and Apple sign-in are not set up on this server yet.'}
          </p>

          {isSignUp && (
            <p className="auth-note">Sign-up is open only to email addresses the server owner has approved.</p>
          )}
        </div>
      </section>
    </main>
  );
}
