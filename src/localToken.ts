const STORAGE_KEY = 'gmgn-local-token';

export function getLocalToken(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

export function setLocalToken(token: string): void {
  const t = token.trim();
  try {
    if (t) sessionStorage.setItem(STORAGE_KEY, t);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

export function hasLocalToken(): boolean {
  return Boolean(getLocalToken());
}
