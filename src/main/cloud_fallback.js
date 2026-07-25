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

async function recoverPassword(email) {
  // Même flux que le « Mot de passe oublié » du site (LoginForm.tsx:187) :
  // Supabase envoie l'email de réinitialisation, le lien atterrit sur
  // <site>/auth/reset-password.
  const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON },
    body: JSON.stringify({ email, redirect_to: `${WORKER_URL}/auth/reset-password` }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error_description || j.msg || `HTTP ${r.status}`);
  }
  return { success: true };
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
  if (!tok) return { loggedIn: false, email: '' };
  // Solde de crédits via GET /api/me (même session cookie que la génération).
  let credits = null;
  try {
    const r = await fetch(`${WORKER_URL}/api/me`, {
      headers: { Cookie: `mfm-session=${tok}` },
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      credits = j.credits ?? j.user?.credits ?? j.profile?.credits ?? null;
    }
  } catch (_) {}
  return { loggedIn: true, email: _mem?.email || '', credits };
}

// -----------------------------------------------------------------------------
// Génération d'images via le worker + téléchargement dans le dossier projet.
// Retourne { success, images:[chemins locaux], creditsRemaining } ou
// { success:false, needsCloudLogin:true } si aucune session valide.
// -----------------------------------------------------------------------------
async function generateImages({ prompt, numImages, imagesDir, assetType, steps, turbo, projectName }) {
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
        // Passerelle desktop->web : le worker insère l'asset dans
        // user_assets => la génération apparaît aussi dans la
        // bibliothèque du compte sur le site.
        ...(projectName ? { projectName } : {}),
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

// -----------------------------------------------------------------------------
// Passerelle bibliothèque/marketplace (2026-07-26)
// Upload d'assets locaux vers la bibliothèque web du compte, listing de la
// bibliothèque, marketplace publique + téléchargement. Tout passe par le
// worker (mêmes sessions/quotas que le site) : upload-image (≤5 Mo, 200/j),
// upload-mesh (GLB ≤50 Mo, 500/j), user-assets/record, cloud-projects,
// meshes, market/list, market/download.
// -----------------------------------------------------------------------------
async function _authedFetch(pathname, init = {}) {
  const tok = await getAccessToken();
  if (!tok) return { needsCloudLogin: true };
  const r = await fetch(`${WORKER_URL}${pathname}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: `mfm-session=${tok}` },
  });
  if (r.status === 401) { logout(); return { needsCloudLogin: true }; }
  return { resp: r };
}

async function shareAsset({ filePath, projectName }) {
  if (!fs.existsSync(filePath)) return { success: false, error: 'file not found' };
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  const isMesh = (ext === '.glb');

  if (isMesh && buf.length > 50 * 1024 * 1024) {
    return { success: false, error: 'Mesh > 50 MB — cloud sharing limit. Decimate it first.' };
  }
  if (!isMesh && buf.length > 5 * 1024 * 1024) {
    return { success: false, error: 'Image > 5 MB — cloud sharing limit.' };
  }

  let uploadedPath = null;
  if (isMesh) {
    const a = await _authedFetch('/api/upload-mesh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: buf.toString('base64'), filename: path.basename(filePath) }),
    });
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true };
    const j = await a.resp.json().catch(() => ({}));
    if (!a.resp.ok || !j.success) return { success: false, error: j.error || `HTTP ${a.resp.status}` };
    uploadedPath = j.path;                       // clé R2
  } else {
    const mime = ext === '.webp' ? 'image/webp' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
    const a = await _authedFetch('/api/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        suffix: path.basename(filePath, ext).slice(0, 40),
      }),
    });
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true };
    const j = await a.resp.json().catch(() => ({}));
    if (!a.resp.ok || !(j.ok || j.success)) return { success: false, error: j.error || `HTTP ${a.resp.status}` };
    // upload-image renvoie une URL signée /r2/<clé>?exp&sig -> extraire la clé
    try {
      const u = new URL(j.path, WORKER_URL);
      uploadedPath = decodeURIComponent(u.pathname.replace(/^\/r2\//, ''));
    } catch (_) { uploadedPath = j.path; }
  }

  // Enregistre dans user_assets pour que l'asset apparaisse dans la
  // bibliothèque web (idempotent côté worker).
  const rec = await _authedFetch('/api/user-assets/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectName: projectName || 'desktop',
      kind: isMesh ? 'mesh-desktop' : 'image-front',
      paths: [uploadedPath],
      meta: { source: 'desktop' },
    }),
  });
  if (!rec.needsCloudLogin) { try { await rec.resp.json(); } catch (_) {} }
  return { success: true, r2Path: uploadedPath };
}

// Opération image générique via le worker : upload de l'image locale
// (≤5 Mo) → endpoint d'op (modify/removebg/upscale/inpaint…) → télécharge
// le résultat au chemin de sortie fourni (même contrat que les outils
// locaux : nouveau fichier à côté de la source).
async function imageOp({ endpoint, srcPath, extraBody = {}, outPath }) {
  if (!fs.existsSync(srcPath)) return { success: false, error: 'source not found' };
  const buf = fs.readFileSync(srcPath);
  if (buf.length > 5 * 1024 * 1024) {
    return { success: false, error: 'Image > 5 MB — cloud tool limit. Downscale it first.' };
  }
  const ext = path.extname(srcPath).toLowerCase();
  const mime = ext === '.webp' ? 'image/webp' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';

  const up = await _authedFetch('/api/upload-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      suffix: 'desktop_op',
    }),
  });
  if (up.needsCloudLogin) return { success: false, needsCloudLogin: true };
  const uj = await up.resp.json().catch(() => ({}));
  if (!up.resp.ok || !(uj.ok || uj.success)) {
    return { success: false, error: uj.error || `upload HTTP ${up.resp.status}` };
  }
  const imageUrl = uj.path;   // URL signée renvoyée par le worker

  const op = await _authedFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl, ...extraBody }),
  });
  if (op.needsCloudLogin) return { success: false, needsCloudLogin: true };
  const oj = await op.resp.json().catch(() => ({}));
  if (op.resp.status === 402) return { success: false, error: 'Not enough MyFabmesh credits. Top up on the website.' };
  if (!op.resp.ok || oj.ok === false || oj.success === false) {
    return { success: false, error: oj.error || `HTTP ${op.resp.status}` };
  }
  const resUrl = oj.path || oj.url || (Array.isArray(oj.paths) && oj.paths[0]);
  if (!resUrl) return { success: false, error: 'no result url in worker response' };
  const dl = await fetch(/^https?:/i.test(resUrl) ? resUrl : `${WORKER_URL}${resUrl}`);
  if (!dl.ok) return { success: false, error: `result download HTTP ${dl.status}` };
  const out = Buffer.from(await dl.arrayBuffer());
  if (out.length < 500) return { success: false, error: 'result too small' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  return { success: true, newPath: outPath, creditsRemaining: oj.creditsRemaining };
}

// Génération 3D (image -> mesh TRELLIS-2) via /api/generate : multipart
// (image en File), job async, polling GET /api/jobs/{id}, download du GLB.
function _findGlbUrl(o) {
  let found = null;
  (function walk(v) {
    if (found) return;
    if (typeof v === 'string') {
      if (/\.glb(\?|#|$)/i.test(v) || (/\/r2\//.test(v) && /mesh/i.test(v))) found = v;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(o);
  return found;
}

async function generateMesh({ imagePath, imagePathBack, assetType, preset, flags = {}, outPath, onProgress }) {
  const tok = await getAccessToken();
  if (!tok) return { success: false, needsCloudLogin: true };

  const fd = new FormData();
  const buf = fs.readFileSync(imagePath);
  fd.append('image', new Blob([buf], { type: 'image/png' }), path.basename(imagePath));
  if (imagePathBack && fs.existsSync(imagePathBack)) {
    try {
      const bb = fs.readFileSync(imagePathBack);
      const up = await _authedFetch('/api/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: `data:image/png;base64,${bb.toString('base64')}`, suffix: 'back' }),
      });
      const uj = up.resp ? await up.resp.json().catch(() => ({})) : {};
      if (uj.path) fd.append('image_back_url', uj.path);
    } catch (_) {}
  }
  fd.append('asset_type', assetType || 'character');
  fd.append('preset', preset || 'fast');
  for (const [k, v] of Object.entries(flags)) fd.append(k, v ? 'true' : 'false');

  const r = await fetch(`${WORKER_URL}/api/generate`, {
    method: 'POST',
    headers: { Cookie: `mfm-session=${tok}` },
    body: fd,
  });
  if (r.status === 401) { logout(); return { success: false, needsCloudLogin: true }; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 402) return { success: false, error: 'Not enough MyFabmesh credits. Top up on the website.' };
  const jobId = j.jobId || j.job_id || j.id;
  if (!r.ok || !jobId) return { success: false, error: j.error || `HTTP ${r.status}` };

  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < 15 * 60 * 1000) {
    await new Promise((res) => setTimeout(res, 4000));
    polls++;
    const a = await _authedFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true };
    const js = await a.resp.json().catch(() => ({}));
    const st = String(js.status || js.state || '');
    try { onProgress?.(st, polls); } catch (_) {}
    if (/succeeded|completed/i.test(st)) {
      const url = _findGlbUrl(js);
      if (!url) return { success: false, error: 'job succeeded but no GLB url in response' };
      const dl = await fetch(/^https?:/i.test(url) ? url : `${WORKER_URL}${url}`,
        { headers: { Cookie: `mfm-session=${tok}` } });
      if (!dl.ok) return { success: false, error: `GLB download HTTP ${dl.status}` };
      const out = Buffer.from(await dl.arrayBuffer());
      if (out.length < 1000) return { success: false, error: 'GLB too small' };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
      return { success: true, meshPath: outPath, size: out.length };
    }
    if (/failed|error|canceled|cancelled/i.test(st)) {
      return { success: false, error: js.error || js.detail || `job ${st}` };
    }
  }
  return { success: false, error: 'cloud 3D generation timeout (15 min)' };
}

async function listLibrary() {
  const a = await _authedFetch('/api/cloud-projects');
  if (a.needsCloudLogin) return { needsCloudLogin: true };
  const projects = (await a.resp.json().catch(() => ({}))).projects || [];
  const b = await _authedFetch('/api/meshes');
  const meshes = b.needsCloudLogin ? [] : ((await b.resp.json().catch(() => ({}))).meshes || (await Promise.resolve([])));
  return { success: true, projects, meshes: Array.isArray(meshes) ? meshes : [] };
}

async function listMarket() {
  const r = await fetch(`${WORKER_URL}/api/market/list`);      // public
  const j = await r.json().catch(() => ({}));
  let owned = [];
  const a = await _authedFetch('/api/market/owned');
  if (!a.needsCloudLogin && a.resp.ok) {
    const oj = await a.resp.json().catch(() => ({}));
    owned = oj.owned || oj.listings || [];
  }
  return { success: r.ok, listings: j.listings || j.items || [], owned };
}

async function downloadItem({ url, marketId, destPath, fname, kind, project }) {
  // Le renderer envoie (kind, fname, project) — on construit ici le chemin
  // absolu dans les dossiers de données de l'app (jamais de chemin libre).
  if (!destPath && fname) {
    const safe = String(fname).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeProj = String(project || 'cloud_import').replace(/[^a-zA-Z0-9_-]/g, '_');
    if (kind === 'mesh' && _deps.MESHES_DIR) {
      destPath = path.join(_deps.MESHES_DIR, safe);
    } else if (_deps.IMAGES_DIR) {
      destPath = path.join(_deps.IMAGES_DIR, safeProj, safe);
    }
  }
  if (!destPath) return { success: false, error: 'no destination' };
  let resp;
  if (marketId) {
    const a = await _authedFetch(`/api/market/download/${encodeURIComponent(marketId)}`);
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true };
    resp = a.resp;
  } else {
    resp = await fetch(url.startsWith('http') ? url : `${WORKER_URL}${url}`);
  }
  if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 100) return { success: false, error: 'empty download' };
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { success: true, path: destPath, size: buf.length };
}

function register(deps) {
  _deps = deps;
  const { ipcMain } = deps;
  ipcMain.handle('cloud-login', async (_e, { email, password } = {}) => {
    try { return await login(String(email || ''), String(password || '')); }
    catch (e) { return { success: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('cloud-recover', async (_e, { email } = {}) => {
    try { return await recoverPassword(String(email || '')); }
    catch (e) { return { success: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('cloud-logout', async () => logout());
  ipcMain.handle('cloud-status', async () => status());
  ipcMain.handle('cloud-share-asset', async (_e, opts = {}) => {
    try { return await shareAsset(opts); }
    catch (e) { return { success: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('cloud-list-library', async () => {
    try { return await listLibrary(); }
    catch (e) { return { success: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('cloud-list-market', async () => {
    try { return await listMarket(); }
    catch (e) { return { success: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('cloud-download-item', async (_e, opts = {}) => {
    try {
      // destPath libre interdit depuis le renderer : seul le couple
      // (kind, fname, project) est accepté — le chemin est construit ici.
      delete opts.destPath;
      return await downloadItem(opts);
    } catch (e) { return { success: false, error: String(e.message || e) }; }
  });
}

module.exports = { register, generateImages, imageOp, generateMesh, getAccessToken, status, login, logout };
