import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthStore } from '../authStore.js';
import { SESSION_COOKIE } from '../authRoutes.js';

/**
 * Test helper: points the server at a throwaway account database, allow-lists one
 * user, and returns a Cookie header value for a signed-in session.
 * Call before the app handles its first request; call cleanup() when done.
 */
export async function createSignedInSession(email = 'tester@example.com') {
  const oldDb = process.env.GMGN_AUTH_DB_PATH;
  const oldAllowed = process.env.GMGN_ALLOWED_EMAILS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmgn-auth-session-'));
  process.env.GMGN_AUTH_DB_PATH = path.join(dir, 'auth.sqlite');
  process.env.GMGN_ALLOWED_EMAILS = email;
  const store = createAuthStore();
  const user = await store.createUser(email, 'test-only-password');
  const { token } = store.createSession(user.id);
  store.close();
  return {
    cookie: `${SESSION_COOKIE}=${token}`,
    cleanup() {
      if (oldDb === undefined) delete process.env.GMGN_AUTH_DB_PATH; else process.env.GMGN_AUTH_DB_PATH = oldDb;
      if (oldAllowed === undefined) delete process.env.GMGN_ALLOWED_EMAILS; else process.env.GMGN_ALLOWED_EMAILS = oldAllowed;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
