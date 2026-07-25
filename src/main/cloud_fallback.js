// =============================================================================
// Fallback cloud pour la génération d'images (certification Store 10.1.2.10).
//
// Sur une machine SANS GPU NVIDIA (Surface, iGPU), les moteurs d'images locaux
// (CUDA) sont inutilisables. Ce module route la génération vers le worker
// MyFabmesh (POST /api/generate-image, synchrone, URLs R2 signées) et
// télécharge les PNG dans le dossier projet — même contrat de sortie que les
// bridges locaux, l'UI ne voit pas la différence.
//
// Auth : le worker lit UNIQUEMENT le cookie `mfm-session=<access_token Supabase>`
// (pas de Bearer). On gère ici une session Supabase (email + mot de passe,
// grant_type=password / refresh_token) ; le refresh token est persisté chiffré
// via electron safeStorage dans userData/cloud_session.json.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

// Constantes publiques (identiques à cloud/wrangler.toml [vars] — l'anon key
// Supabase est par conception publique). Surchargables par env pour les tests.
const WORKER_URL = process.env.FABMESH_CLOUD_URL
  || 'https://myfabmesh-cloud.fabien65400.workers.dev';
const SUPABASE_URL = process.env.FABMESH_SUPABASE_URL
  || 'https://ovoccoipeqmkfnugkmyh.supabase.co';
const SUPABASE_ANON = process.env.FABMESH_SUPABASE_ANON
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92b2Njb2lwZXFta2ZudWdrbXloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MTIzODgsImV4cCI6MjA5NTE4ODM4OH0.0vjGjN1VD_h_MefS4quDFnGXa-nTsbpM2KpNvQZKQlI';

let _deps = null;              // { app, log }
let _mem = null;               // { access_token, expires_at, refresh_token, email }

function _sessionFile() {
  return path.join(_deps.app.getPath('userData'), 'cloud_session.json');
}

function _safeStorage() {
  try { return require('electron').safeStorage; } catch (_) { return null; }
}

function _saveSession() {
  try {
    if (!_mem || !_mem.refresh_token) { try { fs.unlinkSync(_sessionFile()); } catch (_) {} return; }
    const payload = JSON.stringify({ refresh_token: _mem.refresh_token, email: _mem.email || '' });
    const ss = _safeStorage();
    const rec = (ss && ss.isEncryptionAvailable())
      ? { enc: ss.encryptString(payload).toString('base64') }
      : { plain: payload };
    fs.writeFileSync(_sessionFile(), JSON.stringify(rec), 'utf-8');
  } catch (e) { _deps.log?.warn?.('cloud-fallback', `saveSession: ${e.message}`); }
}

function _loadSession() {
  try {
    if (!fs.existsSync(_sessionFile())) return null;
    const rec = JSON.parse(fs.readFileSync(_sessionFile(), 'utf-8'));
    let payload = null;
    if (rec.enc) {
      const ss = _safeStorage();
      if (!ss) return null;
      payload = ss.decryptString(Buffer.from(rec.enc, 'base64'));
    } else if (rec.plain) {
      payload = rec.plain;
    }
    return payload ? JSON.parse(payload) : null;
  } catch (_) { return null; }
}

async function _supabaseToken(body, grant) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const msg = j.error_description || j.msg || j.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  _mem = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || _mem?.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in || 3600) - 90) * 1000,
    email: j.user?.email || _mem?.email || '',
  };
  _saveSession();
  return _mem;
}

async function login(email, password) {
  await _supabaseToken({ email, password }, 'password');
  return { success: true, email: _mem.email };
}

function logout() {
  _mem = null;
  _saveSession();
  return { success: true };
}

async function getAccessToken() {
  if (_mem && _mem.access_token && Date.now() < _mem.expires_at) return _mem.access_token;
  const stored = _mem || _loadSession();
  if (stored && stored.refresh_token) {
    _mem = { ..._mem, ...stored };
    try {
      await _supabaseToken({ refresh_token: stored.refresh_token }, 'refresh_token');
      return _mem.access_token;
    } catch (e) {
      _deps.log?.warn?.('cloud-fallback', `refresh failed: ${e.message}`);
      _mem = null; _saveSession();
    }
  }
  return null;
}

async function status() {
  const tok = await getAccessToken();
  return { loggedIn: !!tok, email: _mem?.email || '' };
}

// -----------------------------------------------------------------------------
// Génération d'images via le worker + téléchargement dans le dossier projet.
// Retourne { success, images:[chemins locaux], creditsRemaining } ou
// { success:false, needsCloudLogin:true } si aucune session valide.
// -----------------------------------------------------------------------------
async function generateImages({ prompt, numImages, imagesDir, assetType, steps, turbo }) {
  const tok = await getAccessToken();
  if (!tok) {
    return { success: false, needsCloudLogin: true,
      error: 'Sign in to your MyFabmesh account to generate images on this device (no NVIDIA GPU detected).' };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
  let resp, data;
  try {
    resp = await fetch(`${WORKER_URL}/api/generate-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `mfm-session=${tok}`,   // le worker ne lit PAS Authorization
      },
      body: JSON.stringify({
        prompt,                          // prompt déjà enrichi par le desktop
        numImages: Math.max(1, Math.min(4, Number(numImages) || 1)),
        asset_type: assetType || 'character',
        steps: Number(steps) || 30,
        turbo: !!turbo,
      }),
      signal: ctrl.signal,
    });
    data = await resp.json().catch(() => ({}));
  } finally { clearTimeout(t); }

  if (resp.status === 401) {
    logout();
    return { success: false, needsCloudLogin: true, error: 'Cloud session expired — please sign in again.' };
  }
  if (resp.status === 402) {
    return { success: false, error: 'Not enough MyFabmesh credits for cloud generation. Top up on the website.' };
  }
  if (!resp.ok || !(data.ok || data.success) || !Array.isArray(data.paths) || !data.paths.length) {
    return { success: false, error: `Cloud generation failed: ${data.error || 'HTTP ' + resp.status}` };
  }

  // Télécharge les URLs R2 signées dans le dossier projet (contrat local).
  fs.mkdirSync(imagesDir, { recursive: true });
  const ts = Date.now();
  const saved = [];
  for (let i = 0; i < data.paths.length; i++) {
    try {
      const r = await fetch(data.paths[i]);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) throw new Error('image trop petite');
      const p = path.join(imagesDir, `ref_${ts}_${i}_cloud.png`);
      fs.writeFileSync(p, buf);
      saved.push(p);
    } catch (e) {
      _deps.log?.warn?.('cloud-fallback', `download ${i}: ${e.message}`);
    }
  }
  if (!saved.length) return { success: false, error: 'Cloud generation succeeded but image download failed.' };
  return { success: true, images: saved, creditsRemaining: data.creditsRemaining };
}

function register(deps) {
  _deps = deps;
  const { ipcMain } = deps;
  ipcMain.handle('cloud-login', async (_e, { email, password } = {}) => {
    try { return await login(String(email || ''), String(password || '')); }
    catch (e) { return { success: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('cloud-logout', async () => logout());
  ipcMain.handle('cloud-status', async () => status());
}

module.exports = { register, generateImages, getAccessToken, status, login, logout };
