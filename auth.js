'use strict';

/**
 * Sign-in for the phone app: OAuth 2.0 authorization code flow with PKCE.
 *
 * No MSAL, no dependencies — the whole flow is four fetches and a redirect, and
 * pulling in a 200KB library to do it would be the largest thing this app ships.
 *
 * PKCE rather than the desktop app's device-code flow because a browser can
 * redirect, and because Microsoft only allows the token endpoint to be called
 * cross-origin from a redirect URI registered as type "SPA". That registration
 * is also what makes the CORS headers appear — a "Web" redirect URI returns the
 * token but the browser is not allowed to read it.
 */

const CLIENT_ID = 'ca1688c6-9077-4485-a565-d0ca35a4cb0a';
const TENANT = 'common';
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;

// ReadWrite, unlike the desktop app's Files.Read: the phone has to write
// ratings and tags back into library.json.
const SCOPES = 'Files.ReadWrite offline_access';

const STORE_KEY = 'video-explorer.tokens';
const VERIFIER_KEY = 'video-explorer.pkce';

let tokens = null;
let refreshing = null;

function redirectUri() {
  // Whatever origin the app is served from, minus any query or hash. Must match
  // a SPA redirect URI in the app registration exactly.
  return location.origin + location.pathname.replace(/\/[^/]*$/, '/');
}

function randomString(bytes = 48) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(raw);
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function load() {
  if (tokens) return tokens;
  try {
    tokens = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    tokens = null;
  }
  return tokens;
}

function store(next) {
  tokens = next;
  localStorage.setItem(STORE_KEY, JSON.stringify(next));
}

export function signedIn() {
  return Boolean(load());
}

export function signOut() {
  tokens = null;
  localStorage.removeItem(STORE_KEY);
}

/** Sends the browser to Microsoft. Returns only in the sense that it never does. */
export async function signIn() {
  const verifier = randomString();
  const state = randomString(12);
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    state,
  });
  location.assign(`${AUTH_BASE}/authorize?${params}`);
}

/**
 * Completes sign-in if this page load is the redirect back from Microsoft.
 * Returns true if it handled a code, so the caller knows to carry on rather
 * than show a sign-in button.
 */
export async function completeSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');

  if (error) {
    // Strip it from the URL so a reload doesn't replay the same failure.
    history.replaceState(null, '', redirectUri());
    throw new Error(params.get('error_description') || error);
  }
  if (!code) return false;

  const saved = JSON.parse(sessionStorage.getItem(VERIFIER_KEY) || 'null');
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!saved) throw new Error('Sign-in state was lost — try again');
  if (saved.state !== params.get('state')) throw new Error('Sign-in state mismatch');

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: saved.verifier,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || 'Token exchange failed');

  store({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
  });
  // The code is single-use; leaving it in the address bar only invites a replay
  // that would fail confusingly on refresh.
  history.replaceState(null, '', redirectUri());
  return true;
}

async function refresh() {
  const current = load();
  if (!current || !current.refresh_token) throw new Error('not signed in');

  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
      scope: SCOPES,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // A rejected refresh token is dead; clearing it turns a confusing loop of
    // failures into a plain "sign in again".
    signOut();
    throw new Error(body.error_description || body.error || 'Session expired');
  }

  store({
    access_token: body.access_token,
    refresh_token: body.refresh_token || current.refresh_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
  });
  return tokens.access_token;
}

/** Concurrent callers share one refresh rather than racing three of them. */
export async function accessToken() {
  const current = load();
  if (!current) throw new Error('not signed in');
  if (Date.now() < current.expires_at) return current.access_token;
  if (!refreshing) {
    refreshing = refresh().finally(() => { refreshing = null; });
  }
  return refreshing;
}

export const config = { CLIENT_ID, SCOPES, redirectUri };
