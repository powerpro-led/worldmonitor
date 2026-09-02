// The operator's Supabase session on disk (~/.worldmonitor/session.json),
// written by `worldmonitor-local login` and kept fresh by local-api-server.mjs's
// startSessionRefreshLoop(). Shared by BOTH writers so the file's schema can
// never drift between them.
//
// This is a sidecar-local sibling module (like _domain-config.mjs / local-sync.mjs)
// so local-api-server.mjs can import it without reaching outside its bundle dir;
// scripts/worldmonitor-local.mjs imports it by relative path the same way it
// already references SERVER_SCRIPT here.

import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Absolute path to session.json. Resolved fresh on every call so a test that
 * sets WM_LOCAL_SESSION_FILE *after* import (local-api-server.test.mjs does)
 * is still honoured.
 */
export function operatorSessionFilePath() {
  return process.env.WM_LOCAL_SESSION_FILE || path.join(os.homedir(), '.worldmonitor', 'session.json');
}

/**
 * The full Supabase session object, or null when the file is absent/malformed.
 * Claims are read, not verified — the login flow that produced the file already
 * went through Supabase + the org-membership gate, and every /api/* route still
 * independently rejects a bearer it can't validate.
 */
export function readOperatorSession(sessionFile = operatorSessionFilePath()) {
  try {
    const session = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    return session && typeof session === 'object' ? session : null;
  } catch {
    return null;
  }
}

/**
 * Rewrites session.json (0600) with the trimmed field set both the CLI login
 * flow and the backend refresh timer agree on. Creates ~/.worldmonitor/ (0700)
 * if absent — matters for a first-ever `login` with no prior `install`.
 * `chmodSync` after the write because writeFileSync's `mode` only applies on
 * file *creation*; an overwrite of an existing file would otherwise keep its
 * old perms. Returns the trimmed object that was written.
 */
export function writeOperatorSession(session, sessionFile = operatorSessionFilePath()) {
  const trimmed = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    token_type: session.token_type,
    user: { id: session.user?.id, email: session.user?.email },
  };
  mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
  chmodSync(sessionFile, 0o600);
  return trimmed;
}
