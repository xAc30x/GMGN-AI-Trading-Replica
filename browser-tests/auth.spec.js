import { test, expect } from '@playwright/test';

const EMAIL = 'bailey@example.com';
const PASSWORD = 'correct horse battery';

/**
 * Fakes the sign-in API in the page. Other /api calls answer 404 so the dashboard
 * loads without a real server. Returns the requests the page sent to the auth routes.
 */
async function installAuthFixtures(page, { signedIn = false, meStatus, google = false, apple = false } = {}) {
  const state = { signedIn, requests: [], healthStatus: 404, externalResult: 'ok' };
  await page.addInitScript(() => { localStorage.setItem('gmgn.tutorial.seen.v1', 'true'); });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    let body = null;
    try { body = request.postDataJSON(); } catch { /* GET request */ }
    if (url.pathname.startsWith('/api/auth/')) {
      state.requests.push({ path: url.pathname, body, contentType: request.headers()['content-type'] || '' });
    }
    if (url.pathname === '/api/auth/me') {
      if (meStatus) return route.fulfill({ status: meStatus, json: { ok: false, error: 'boom' } });
      return state.signedIn
        ? route.fulfill({ json: { ok: true, user: { email: EMAIL } } })
        : route.fulfill({ status: 401, json: { ok: false, error: 'Not signed in' } });
    }
    if (url.pathname === '/api/auth/signin') {
      if (body?.email !== EMAIL || body?.password !== PASSWORD) {
        return route.fulfill({ status: 401, json: { ok: false, error: 'Email or password is incorrect' } });
      }
      state.signedIn = true;
      return route.fulfill({ json: { ok: true, user: { email: EMAIL } } });
    }
    if (url.pathname === '/api/auth/signup') {
      if (body?.email !== EMAIL) {
        return route.fulfill({ status: 403, json: { ok: false, error: 'Sign-up is closed for this email address' } });
      }
      state.signedIn = true;
      return route.fulfill({ status: 201, json: { ok: true, user: { email: EMAIL } } });
    }
    if (url.pathname === '/api/auth/providers') return route.fulfill({ json: { ok: true, google, apple } });
    const external = url.pathname.match(/^\/api\/auth\/(google|apple)\/start$/);
    if (external) {
      // Stands in for the whole trip to Google or Apple and back.
      if (state.externalResult === 'ok') state.signedIn = true;
      const location = state.externalResult === 'ok' ? '/' : `/?signin_error=${state.externalResult}&signin_provider=${external[1]}`;
      return route.fulfill({ status: 303, headers: { location } });
    }
    if (url.pathname === '/api/auth/signout') {
      state.signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (!state.signedIn) {
      return route.fulfill({ status: 401, json: { ok: false, error: 'Sign in required', code: 'SIGN_IN_REQUIRED' } });
    }
    if (url.pathname === '/api/health' && state.healthStatus === 401) {
      return route.fulfill({ status: 401, json: { ok: false, error: 'Sign in required', code: 'SIGN_IN_REQUIRED' } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: 'not part of this fixture' } });
  });
  return state;
}

const dashboard = page => page.getByRole('group', { name: 'Trading mode' });

test('signed-out visitors see the sign-in page first, and a correct password opens the dashboard', async ({ page }) => {
  const state = await installAuthFixtures(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AI Trader' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
  await expect(dashboard(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeDisabled();

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('wrong password!!');
  await page.getByRole('button', { name: 'Sign in with email' }).click();
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect');
  await expect(dashboard(page)).toHaveCount(0);

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in with email' }).click();
  await expect(dashboard(page)).toBeVisible();
  const signin = state.requests.filter(r => r.path === '/api/auth/signin').at(-1);
  expect(signin.body).toEqual({ email: EMAIL, password: PASSWORD });
  expect(signin.contentType).toContain('application/json');
});

test('sign-up checks the password before sending and shows the server answer', async ({ page }) => {
  const state = await installAuthFixtures(page);
  await page.goto('/');
  await page.getByRole('tab', { name: 'Sign up' }).click();
  await expect(page.getByText('Sign-up is open only to email addresses the server owner has approved.')).toBeVisible();

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('too short');
  await page.getByLabel('Confirm password').fill('too short');
  await page.getByRole('button', { name: 'Sign up with email' }).click();
  await expect(page.getByRole('alert')).toHaveText('Password must be at least 12 characters');

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(`${PASSWORD}x`);
  await page.getByRole('button', { name: 'Sign up with email' }).click();
  await expect(page.getByRole('alert')).toHaveText('The two passwords do not match');
  expect(state.requests.filter(r => r.path === '/api/auth/signup')).toHaveLength(0);

  await page.getByLabel('Email').fill('stranger@example.com');
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up with email' }).click();
  await expect(page.getByRole('alert')).toHaveText('Sign-up is closed for this email address');

  await page.getByLabel('Email').fill(EMAIL);
  await page.getByRole('button', { name: 'Sign up with email' }).click();
  await expect(dashboard(page)).toBeVisible();
});

test('a signed-in visitor goes straight to the dashboard and can sign out from Settings', async ({ page }) => {
  const state = await installAuthFixtures(page, { signedIn: true });
  await page.goto('/');
  await expect(dashboard(page)).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Setup & credentials' });
  await expect(settings.getByText(EMAIL)).toBeVisible();
  await settings.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('tab', { name: 'Sign in' })).toBeVisible();
  await expect(dashboard(page)).toHaveCount(0);
  expect(state.requests.some(r => r.path === '/api/auth/signout')).toBe(true);

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Sign in' })).toBeVisible();
});

test('when the server ends the session, the page returns to sign-in with a note', async ({ page }) => {
  const state = await installAuthFixtures(page, { signedIn: true });
  state.healthStatus = 401;
  await page.goto('/');
  await expect(page.getByText('Your session ended. Please sign in again.')).toBeVisible();
  await expect(dashboard(page)).toHaveCount(0);
});

test('a server that cannot be reached shows a note instead of the dashboard', async ({ page }) => {
  await installAuthFixtures(page, { meStatus: 502 });
  await page.goto('/');
  await expect(page.getByText(/Could not reach the server/)).toBeVisible();
  await expect(dashboard(page)).toHaveCount(0);
});

test('Continue with Google is off until the server has Google set up', async ({ page }) => {
  await installAuthFixtures(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  await expect(page.getByText('Google and Apple sign-in are not set up on this server yet.')).toBeVisible();
});

test('Continue with Google signs in through the server and opens the dashboard', async ({ page }) => {
  const state = await installAuthFixtures(page, { google: true });
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Continue with Google' });
  await expect(button).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue with Apple' })).toBeDisabled();
  await button.click();
  await expect(dashboard(page)).toBeVisible();
  expect(state.requests.some(r => r.path === '/api/auth/google/start')).toBe(true);
});

test('a refused Google sign-in comes back with a plain message and a clean address', async ({ page }) => {
  const state = await installAuthFixtures(page, { google: true });
  state.externalResult = 'not_allowed';
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByText('This Google account’s email is not approved for this app.')).toBeVisible();
  await expect(dashboard(page)).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
});

test('Continue with Apple works the same way once Apple is set up', async ({ page }) => {
  const state = await installAuthFixtures(page, { apple: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  await expect(page.getByText('Google sign-in is not set up on this server yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue with Apple' }).click();
  await expect(dashboard(page)).toBeVisible();
  expect(state.requests.some(r => r.path === '/api/auth/apple/start')).toBe(true);
});

test('a cancelled Apple sign-in names Apple in its message', async ({ page }) => {
  const state = await installAuthFixtures(page, { google: true, apple: true });
  state.externalResult = 'cancelled';
  await page.goto('/');
  await expect(page.getByText(/not set up on this server/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue with Apple' }).click();
  await expect(page.getByText('Apple sign-in was cancelled.')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});
