import { config } from '../config';
import { monthFolderName } from './format';

/**
 * Google Drive + Sheets access with the signed-in user's own Google
 * Workspace permissions. Access tokens come from the Firebase sign-in popup
 * and are renewed with Google Identity Services when they expire.
 */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'];

let cached: { token: string; exp: number } | null = null;
let hintEmail = '';

export function setGoogleToken(token: string, ttlSeconds = 3300) {
  cached = { token, exp: Date.now() + ttlSeconds * 1000 };
}
export function setGoogleHint(email: string) {
  hintEmail = email;
}
export const clearGoogleToken = () => void (cached = null);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window { google?: any }
}

let gisLoading: Promise<void> | null = null;
export function loadGoogleIdentity(): Promise<void> {
  gisLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisLoading = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
    document.head.appendChild(s);
  });
  return gisLoading;
}

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.token;
  if (!config.google.clientId) throw new Error('Google OAuth client ID is not configured (VITE_GOOGLE_CLIENT_ID).');
  await loadGoogleIdentity();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: config.google.clientId,
      scope: GOOGLE_SCOPES.join(' '),
      hint: hintEmail,
      prompt: '',
      callback: (r: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => {
        if (r.error || !r.access_token) return reject(new Error(r.error_description || r.error || 'Google access was not granted.'));
        setGoogleToken(r.access_token, Number(r.expires_in ?? 3600) - 120);
        resolve(r.access_token);
      },
      error_callback: (e: { type?: string; message?: string }) =>
        reject(new Error(e?.type === 'popup_closed' ? 'The Google access window was closed.'
          : e?.type === 'popup_failed_to_open' ? 'The browser blocked the Google access pop-up. Allow pop-ups for this site and try again.'
          : e?.message || 'Google authorisation failed.')),
    });
    client.requestAccessToken();
  });
}

async function call<T>(url: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
  if (res.status === 401 && retry) {
    clearGoogleToken();
    return call(url, init, false);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
    throw new Error(`Google ${res.status}: ${msg}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ── Drive ────────────────────────────────────────────────────────────────────
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const ALL_DRIVES = 'supportsAllDrives=true';
const folderIds = new Map<string, string>();

async function monthFolderId(serviceMonth: string): Promise<string> {
  const name = monthFolderName(serviceMonth);
  const hit = folderIds.get(name);
  if (hit) return hit;
  const root = config.google.driveFolderId;
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${root}' in parents and trashed=false`;
  const found = await call<{ files: { id: string }[] }>(
    `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)&${ALL_DRIVES}&includeItemsFromAllDrives=true&corpora=allDrives`,
  );
  const id = found.files[0]?.id
    ?? (await call<{ id: string }>(`${DRIVE}?${ALL_DRIVES}&fields=id`, {
      method: 'POST',
      ...json({ name, mimeType: 'application/vnd.google-apps.folder', parents: [root] }),
    })).id;
  folderIds.set(name, id);
  return id;
}

const driveError = (e: unknown) =>
  new Error(`Could not save to Google Drive — ${(e as Error).message}. Check that you have edit access to the invoices folder.`);

export const driveViewUrl = (fileId: string) => `https://drive.google.com/file/d/${fileId}/view`;

/** Uploads into <root>/<service month>/ and returns the Drive file id. */
export async function uploadToDrive(file: File, name: string, serviceMonth: string): Promise<string> {
  try {
    const parent = await monthFolderId(serviceMonth);
    const body = new FormData();
    body.append('metadata', new Blob([JSON.stringify({ name, parents: [parent] })], { type: 'application/json' }));
    body.append('file', file);
    const r = await call<{ id: string }>(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${ALL_DRIVES}&fields=id`, { method: 'POST', body });
    return r.id;
  } catch (e) {
    throw driveError(e);
  }
}

/** Moves/renames a file when the invoice's service month or identifiers change. */
export async function relocateDriveFile(fileId: string, name: string, serviceMonth: string): Promise<void> {
  try {
    const parent = await monthFolderId(serviceMonth);
    const f = await call<{ parents?: string[] }>(`${DRIVE}/${fileId}?fields=parents&${ALL_DRIVES}`);
    const parents = f.parents ?? [];
    const move = parents.includes(parent) ? '' : `&addParents=${parent}&removeParents=${parents.join(',')}`;
    await call(`${DRIVE}/${fileId}?${ALL_DRIVES}&fields=id${move}`, { method: 'PATCH', ...json({ name }) });
  } catch (e) {
    throw driveError(e);
  }
}

// ── Sheets ───────────────────────────────────────────────────────────────────
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
export type SheetTab = { title: string; rows: (string | number)[][] };

/** Replaces the content of each tab (creating missing tabs) with the given rows. */
export async function writeSheetTabs(tabs: SheetTab[]): Promise<void> {
  const id = config.google.sheetId;
  const meta = await call<{ sheets: { properties: { title: string } }[] }>(`${SHEETS}/${id}?fields=sheets.properties.title`);
  const existing = new Set(meta.sheets.map((s) => s.properties.title));
  const missing = tabs.filter((t) => !existing.has(t.title));
  if (missing.length) {
    await call(`${SHEETS}/${id}:batchUpdate`, {
      method: 'POST',
      ...json({ requests: missing.map((t) => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } })) }),
    });
  }
  const range = (t: SheetTab) => `'${t.title.replace(/'/g, "''")}'`;
  await call(`${SHEETS}/${id}/values:batchClear`, { method: 'POST', ...json({ ranges: tabs.map(range) }) });
  // RAW keeps vendor text such as "=..." from being treated as a formula. Append grows the grid as needed.
  for (const t of tabs) {
    if (!t.rows.length) continue;
    await call(`${SHEETS}/${id}/values/${encodeURIComponent(range(t) + '!A1')}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`, {
      method: 'POST',
      ...json({ values: t.rows }),
    });
  }
}
