/**
 * Browser side of sign-in. The session lives in an HttpOnly cookie that scripts
 * cannot read; these calls only ask the server to create, check or end it.
 */

export interface AuthUser {
  email: string;
}

/** Fired when any API call reports the session is gone, so the app returns to the sign-in page. */
export const SIGNED_OUT_EVENT = 'gmgn:signed-out';

/** Mirrors the server's password rule so the form can say it before sending. */
export const PASSWORD_MIN_LENGTH = 12;

async function authFetch(url: string, body?: unknown): Promise<{ status: number; data: { ok?: boolean; error?: string; user?: AuthUser } }> {
  const res = await fetch(url, body === undefined
    ? { credentials: 'same-origin' }
    : {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function failure(status: number, error?: string): Error {
  if (status === 429) return new Error(error || 'Too many attempts. Try again later.');
  return new Error(error || `Server error (HTTP ${status})`);
}

/** The signed-in user, or null when nobody is signed in. Throws when the server cannot be reached. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const { status, data } = await authFetch('/api/auth/me');
  if (status === 401) return null;
  if (status !== 200 || !data.user) throw failure(status, data.error);
  return data.user;
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const { status, data } = await authFetch('/api/auth/signin', { email, password });
  if (status !== 200 || !data.user) throw failure(status, data.error);
  return data.user;
}

export async function signUp(email: string, password: string): Promise<AuthUser> {
  const { status, data } = await authFetch('/api/auth/signup', { email, password });
  if (status !== 201 || !data.user) throw failure(status, data.error);
  return data.user;
}

export async function signOut(): Promise<void> {
  const { status, data } = await authFetch('/api/auth/signout', {});
  if (status !== 200) throw failure(status, data.error);
}

/** Call with an API error body; signals the app when the server says the session has ended. */
export function noteSignInRequired(status: number, body: unknown): void {
  if (status === 401 && (body as { code?: string } | null)?.code === 'SIGN_IN_REQUIRED') {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
}

export interface SignInProviders {
  google: boolean;
  apple: boolean;
}

/** Which outside sign-in options the server has set up. Treats any failure as "none". */
export async function fetchProviders(): Promise<SignInProviders> {
  try {
    const { status, data } = await authFetch('/api/auth/providers');
    const d = data as Partial<SignInProviders>;
    return status === 200 ? { google: d.google === true, apple: d.apple === true } : { google: false, apple: false };
  } catch {
    return { google: false, apple: false };
  }
}

export type ExternalProvider = 'google' | 'apple';

const PROVIDER_LABELS: Record<ExternalProvider, string> = { google: 'Google', apple: 'Apple' };

/** Leaves the app for Google or Apple; the server brings the browser back signed in, or with ?signin_error=. */
export function startExternalSignIn(provider: ExternalProvider): void {
  window.location.assign(`/api/auth/${provider}/start`);
}

function signInErrorMessage(code: string, provider: string | null): string {
  const label = provider === 'google' || provider === 'apple' ? PROVIDER_LABELS[provider] : 'Google or Apple';
  switch (code) {
    case 'not_configured': return `${label} sign-in is not set up on this server.`;
    case 'cancelled': return `${label} sign-in was cancelled.`;
    case 'expired': return 'That sign-in attempt expired or was already used. Please try again.';
    case 'unverified': return `${label} has not verified that email address, so it cannot be used to sign in.`;
    case 'not_allowed': return `This ${label} account’s email is not approved for this app.`;
    default: return `${label} sign-in failed. Please try again.`;
  }
}

let signInErrorOnLoad: string | undefined;

/**
 * The reason the server put in ?signin_error= after an outside sign-in, as a message
 * to show (or ''). Read once per page load, then removed from the address bar; later
 * calls return the same answer (React may run start-up effects twice in development).
 */
export function takeSignInError(): string {
  if (signInErrorOnLoad !== undefined) return signInErrorOnLoad;
  const url = new URL(window.location.href);
  const code = url.searchParams.get('signin_error');
  signInErrorOnLoad = code === null ? '' : signInErrorMessage(code, url.searchParams.get('signin_provider'));
  if (code !== null) {
    url.searchParams.delete('signin_error');
    url.searchParams.delete('signin_provider');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  return signInErrorOnLoad;
}
