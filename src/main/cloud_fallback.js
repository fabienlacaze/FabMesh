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
// Sidecars lineage <artefact>.meta.json — utilisés pour la stratégie R2-reuse
// (params.r2_url) des outils mesh en mode Cloud.
const { readMeta, writeMeta } = require('./meta');

// Constantes publiques (identiques à cloud/wrangler.toml [vars] — l'anon key
// Supabase est par conception publique). Surchargables par env pour les tests.
const WORKER_URL = process.env.FABMESH_CLOUD_URL
  || 'https://myfabmesh-cloud.fabien65400.workers.dev';
const SUPABASE_URL = process.env.FABMESH_SUPABASE_URL
  || 'https://ovoccoipeqmkfnugkmyh.supabase.co';
const SUPABASE_ANON = process.env.FABMESH_SUPABASE_ANON
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im92b2Njb2lwZXFta2ZudWdrbXloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2MTIzODgsImV4cCI6MjA5NTE4ODM4OH0.0vjGjN1VD_h_MefS4quDFnGXa-nTsbpM2KpNvQZKQlI';

// Message par défaut de toute réponse needsCloudLogin : plusieurs call sites du
// renderer affichent `r.error` tel quel — sans ce texte l'utilisateur voyait
// « unknown » / « cloud 3D generation failed » au lieu d'une invitation à se
// connecter (cert Store 10.1.2.10).
const CLOUD_LOGIN_ERR = 'Sign in to your MyFabmesh account to use cloud generation on this device.';

// Message final honnête quand le second essai échoue lui aussi (cert Store
// 10.1.2.10 : le testeur doit comprendre que rien n'est cassé et que rien
// n'est facturé). Vérifié endpoint par endpoint : le worker rembourse
// TOUJOURS avant de répondre sur ces chemins — addCredits + refundModalSpend
// dans les catch de handleGenerateImage, handleModifyImage, handleMaskInpaint,
// handleUpscaleImage, handleRemoveBackground, handleMeshOp et
// handleConstructionStages3d.
const COLD_START_ERR = 'The cloud GPU took too long to start (cold start). '
  + 'Please try again in a minute — your credits were refunded.';

let _deps = null;              // { app, log, safeSend }
let _mem = null;               // { access_token, expires_at, refresh_token, email }

// -----------------------------------------------------------------------------
// Cold start Modal — retry unique partagé par tous les points d'entrée cloud.
//
// Un conteneur GPU Modal froid met 2-3 min à démarrer et Cloudflare coupe toute
// sous-requête à 100 s en renvoyant 524 : le tout premier clic d'un testeur
// tombait sur « image generation failed (credits refunded): Cloud GPU HTTP
// 524 ». Le worker a DÉJÀ remboursé les crédits ET le budget Modal dans son
// bloc catch avant de répondre — le retry est donc un appel NEUF, entièrement
// re-facturé s'il réussit, JAMAIS un double débit : on ne paie que la
// tentative qui aboutit.
//
// Le délai par défaut est de 60 s et NE DOIT PAS être raccourci à ~20 s : un
// 524 Cloudflare n'annule pas la requête Modal, FastAPI continue de la traiter
// jusqu'au bout (~30-60 s de boot + 25-45 s de diffusion) et @app.cls ne sert
// qu'une entrée par conteneur. Rejouer trop tôt fait donc démarrer un SECOND
// conteneur froid par autoscale : facture GPU doublée et second 524. À 60 s la
// première génération (jetée) est terminée et le conteneur est chaud et libre,
// dans sa fenêtre scaledown de 300 s (modal_app/app.py:525).
//
// Un seul rejeu par action utilisateur : chaque tentative consomme un slot du
// quota MAX_USER_DAILY_CALLS (40/j) qui, lui, n'est PAS remboursé par le
// worker (seuls les crédits et le budget $ le sont).
// -----------------------------------------------------------------------------
const COLD_RETRY_DELAY_MS = 60 * 1000;

function _progress(msg) {
  try { _deps?.safeSend?.('ai3d-progress', `[cloud] ${msg}\n`); } catch (_) {}
}

function _isColdStart(status, msg) {
  const st = Number(status);
  if ([502, 503, 504, 524].includes(st)) return true;
  return /\b(524|502|503|504)\b|cold start|timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|UND_ERR_HEADERS_TIMEOUT|warm up/i
    .test(String(msg || ''));
}

// Vrai si le résultat d'une tentative ressemble à un cold start rejouable.
// Exclusions strictes : session expirée (il faut se reconnecter), crédits
// insuffisants (402) et quota/budget atteint (429) ne doivent JAMAIS être
// rejoués.
function _resultIsColdStart(r) {
  if (!r || r.success !== false) return false;
  if (r.needsCloudLogin) return false;
  const st = Number(r._httpStatus || 0);
  if (st === 402 || st === 429) return false;
  return _isColdStart(st, r.error);
}

// Joue fn() une fois ; si le résultat ressemble à un cold start, prévient
// l'utilisateur, attend delayMs et rejoue UNE seule fois.
async function _withColdRetry(fn, { label = 'cloud operation', delayMs = COLD_RETRY_DELAY_MS } = {}) {
  const strip = (r) => { if (r && typeof r === 'object') delete r._httpStatus; return r; };
  let r = await fn();
  if (!_resultIsColdStart(r)) return strip(r);
  _deps?.log?.info?.('cloud-fallback', `${label}: cold start detected — retry in ${delayMs / 1000}s`);
  _progress(`Cloud GPU is starting up (cold start), retrying in ${Math.round(delayMs / 1000)}s…`);
  await new Promise((res) => setTimeout(res, delayMs));
  _progress('Retrying on the cloud GPU…');
  r = await fn();
  if (_resultIsColdStart(r)) return { success: false, error: COLD_START_ERR };
  return strip(r);
}

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
  // PRÉCHAUFFAGE APRÈS CONNEXION — cause du refus de certification
  // Microsoft du 28/07/2026 (« Image generation failed - The cloud GPU
  // took too long to start »). Le préchauffage du démarrage s'exécute
  // 8 s après le lancement et exige un jeton de session : pour un
  // PREMIER lancement il sort donc immédiatement sur needsCloudLogin,
  // sans jamais toucher Modal. Le testeur se connectait ensuite et son
  // premier clic payait les 2-3 min de démarrage à froid, que la
  // fenêtre de rejeu (~6 min) ne rattrapait pas toujours.
  //
  // `force` contourne le débounce de 4 min : on VEUT chauffer ici même
  // si un préchauffage a été tenté juste avant sans session.
  // Fire-and-forget, jamais bloquant pour la connexion.
  try { prewarm({ force: true }).catch(() => {}); } catch (_) {}
  try { _startHeartbeat(); } catch (_) {}
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
  // Budget d'abandon porté de 5 à 10 min : le worker rejoue lui-même un 524
  // deux fois (60 s + 90 s) avant de répondre, donc une tentative légitime
  // peut durer ~350 s — l'ancien AbortController de 300 s tuait une requête
  // que le worker était sur le point de satisfaire.
  const attempt = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
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
    } catch (e) {
      // Abort / socket coupé : traité comme un cold start rejouable.
      return { success: false, error: String((e && e.message) || e), _httpStatus: 0 };
    } finally { clearTimeout(t); }

    if (resp.status === 401) {
      logout();
      return { success: false, needsCloudLogin: true, error: 'Cloud session expired — please sign in again.' };
    }
    if (resp.status === 402) {
      return { success: false, _httpStatus: 402,
        error: 'Not enough MyFabmesh credits for cloud generation. Top up on the website.' };
    }
    if (!resp.ok || !(data.ok || data.success) || !Array.isArray(data.paths) || !data.paths.length) {
      // Le worker emballe le 524 amont dans SON propre 502 : le statut seul ne
      // suffit pas, on donne aussi le texte à l'analyse cold start.
      return { success: false, _httpStatus: resp.status,
        error: `Cloud generation failed: ${data.error || 'HTTP ' + resp.status}` };
    }
    return { success: true, data };
  };

  const first = await _withColdRetry(attempt, { label: 'image generation' });
  if (!first.success) return first;
  const data = first.data;

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
  if (!tok) return { needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
  const r = await fetch(`${WORKER_URL}${pathname}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: `mfm-session=${tok}` },
  });
  if (r.status === 401) { logout(); return { needsCloudLogin: true, error: CLOUD_LOGIN_ERR }; }
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
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
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
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
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
  if (up.needsCloudLogin) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
  const uj = await up.resp.json().catch(() => ({}));
  if (!up.resp.ok || !(uj.ok || uj.success)) {
    return { success: false, error: uj.error || `upload HTTP ${up.resp.status}` };
  }
  const imageUrl = uj.path;   // URL signée renvoyée par le worker

  // L'appel d'op passe par _postJsonLong (et PAS par le fetch Node) : undici
  // coupe à 300 s si les headers de réponse n'arrivent pas, or le worker
  // rejoue lui-même un 524 deux fois (callModalImageOp) et peut donc mettre
  // ~450 s à répondre — on voyait alors un « fetch failed » opaque côté
  // desktop alors que le worker travaillait encore.
  const attempt = async () => {
    const op = await _authedPostLong(endpoint, { imageUrl, ...extraBody }, 12 * 60 * 1000);
    if (op.needsCloudLogin) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
    if (op.error) return { success: false, error: op.error, _httpStatus: 0 };
    const j = op.json || {};
    if (op.status === 402) {
      return { success: false, _httpStatus: 402, error: 'Not enough MyFabmesh credits. Top up on the website.' };
    }
    if (!(op.status >= 200 && op.status < 300) || j.ok === false || j.success === false) {
      return { success: false, _httpStatus: op.status, error: _httpErr(op.status, j) };
    }
    return { success: true, json: j };
  };
  const opRes = await _withColdRetry(attempt, { label: `image op ${endpoint}` });
  if (!opRes.success) return opRes;
  const oj = opRes.json || {};
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

// -----------------------------------------------------------------------------
// Outils MESH en mode Cloud (2026-07-26) — stratégie R2-REUSE.
// Les endpoints mesh du worker (/api/mesh-op, /api/construction-stages-3d,
// /api/mesh-segment, /api/auto-rig, /api/animate) consomment un meshUrl /
// mesh_url (URL signée R2), PAS un fichier :
//   (a) sidecar <mesh>.glb.meta.json → params.r2_url (GLB générés/opérés en
//       cloud) → réutilisation directe, zéro upload ;
//   (b) sinon POST /api/upload-mesh (GLB ≤50 Mo) → URL signée (j.url, PAS la
//       clé brute j.path : les endpoints valident l'host d'une URL https) ;
//   (c) sinon erreur claire.
// Après chaque op réussie le handler appelant télécharge le résultat au chemin
// local habituel ET mémorise l'URL R2 du résultat dans le sidecar du nouveau
// fichier → chaînage d'ops sans re-upload.
// -----------------------------------------------------------------------------
const MESH_UPLOAD_LIMIT = 50 * 1024 * 1024;

function _absUrl(u) { return /^https?:/i.test(u) ? u : `${WORKER_URL}${u}`; }

// Une URL signée mémorisée peut être périmée (TTL 7 j) ou l'host refusé par
// isTrustedAssetHost — dans ce cas on retombe sur un upload frais et on
// rejoue l'appel UNE fois.
function _staleUrlError(msg, status) {
  if (status === 403) return true;
  return /(host|not allowed|forbidden|expired|signature|invalid.{0,12}url)/i.test(String(msg || ''));
}

async function resolveMeshUrl(meshPath, { forceUpload = false } = {}) {
  if (!meshPath || !fs.existsSync(meshPath)) return { success: false, error: 'mesh not found' };
  if (!forceUpload) {
    const m = readMeta(meshPath);
    const u = m && m.params && m.params.r2_url;
    if (u && /^https?:/i.test(String(u))) return { success: true, meshUrl: String(u), uploaded: false };
  }
  const st = fs.statSync(meshPath);
  if (st.size > MESH_UPLOAD_LIMIT) {
    return { success: false, error: 'Mesh > 50 MB — indisponible en mode Cloud (générez-le en Cloud ou décimez-le)' };
  }
  const buf = fs.readFileSync(meshPath);
  const a = await _authedFetch('/api/upload-mesh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64: buf.toString('base64'), filename: path.basename(meshPath) }),
  });
  if (a.needsCloudLogin) return { success: false, needsCloudLogin: true, error: 'Cloud session expired — please sign in again.' };
  const j = await a.resp.json().catch(() => ({}));
  if (!a.resp.ok || !(j.success || j.ok) || !(j.url || j.path)) {
    return { success: false, error: j.error || `upload-mesh HTTP ${a.resp.status}` };
  }
  const meshUrl = _absUrl(String(j.url || j.path));
  // Persister r2_url dans le sidecar SANS l'écraser : writeMeta remplace le
  // fichier entier → readMeta → merge → writeMeta.
  try {
    const m = readMeta(meshPath) || { kind: 'mesh' };
    m.params = { ...(m.params || {}), r2_url: meshUrl };
    writeMeta(meshPath, m);
  } catch (_) {}
  return { success: true, meshUrl, uploaded: true };
}

// Upload d'une image locale (≤5 Mo) → URL signée. Utilisé par retex_swap
// (params.image_url) — même flux que la première moitié d'imageOp.
async function uploadImage(srcPath, suffix = 'desktop_op') {
  if (!srcPath || !fs.existsSync(srcPath)) return { success: false, error: 'source image not found' };
  const buf = fs.readFileSync(srcPath);
  if (buf.length > 5 * 1024 * 1024) {
    return { success: false, error: 'Image > 5 MB — cloud tool limit. Downscale it first.' };
  }
  const ext = path.extname(srcPath).toLowerCase();
  const mime = ext === '.webp' ? 'image/webp' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
  const up = await _authedFetch('/api/upload-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: `data:${mime};base64,${buf.toString('base64')}`, suffix }),
  });
  if (up.needsCloudLogin) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
  const uj = await up.resp.json().catch(() => ({}));
  if (!up.resp.ok || !(uj.ok || uj.success) || !uj.path) {
    return { success: false, error: uj.error || `upload HTTP ${up.resp.status}` };
  }
  return { success: true, url: _absUrl(String(uj.path)) };
}

// Télécharge une URL (signée R2 ou relative worker) vers un chemin local.
async function _downloadTo(url, outPath, minBytes = 500) {
  const tok = await getAccessToken();
  const r = await fetch(_absUrl(url), tok ? { headers: { Cookie: `mfm-session=${tok}` } } : undefined);
  if (!r.ok) return { success: false, error: `result download HTTP ${r.status}` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < minBytes) return { success: false, error: 'result too small' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return { success: true, size: buf.length };
}

// POST JSON avec timeout LONG via http(s) natif. Le fetch Node (undici) coupe
// à 300 s si les headers de réponse n'arrivent pas — trop court pour les
// endpoints mesh SYNC du worker (mesh-op retex ≈ minutes, construction-stages
// ≈ 10 min : budget interne Modal 290 s + 120 s/stage). Le timeout ici est un
// timeout d'INACTIVITÉ socket, par défaut 12 min.
function _postJsonLong(pathname, body, cookie, timeoutMs = 12 * 60 * 1000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(_absUrl(pathname)); } catch (e) { resolve({ error: e }); return; }
    const mod = (u.protocol === 'http:') ? require('http') : require('https');
    const data = JSON.stringify(body || {});
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Cookie: cookie,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`cloud request timeout (${Math.round(timeoutMs / 60000)} min)`)));
    req.on('error', (e) => resolve({ error: e }));
    req.write(data);
    req.end();
  });
}

async function _authedPostLong(pathname, body, timeoutMs) {
  const tok = await getAccessToken();
  if (!tok) return { needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
  const r = await _postJsonLong(pathname, body, `mfm-session=${tok}`, timeoutMs);
  if (r.error) return { error: String(r.error.message || r.error) };
  if (r.status === 401) { logout(); return { needsCloudLogin: true, error: CLOUD_LOGIN_ERR }; }
  let j = {};
  try { j = JSON.parse(r.text); } catch (_) {}
  return { status: r.status, json: j };
}

function _httpErr(status, j) {
  if (status === 402) return 'Not enough MyFabmesh credits. Top up on the website.';
  if (status === 429) return 'Cloud rate/budget limit reached — try again later.';
  return (j && j.error) || `HTTP ${status}`;
}

// Cold start sur la forme de réponse d'_authedPostLong ({ status, json } ou
// { error }). Sert aux ops SYNC (mesh-op, construction-stages-3d) qui ont déjà
// leur propre rejeu « URL signée périmée » : les deux rejeux ne doivent JAMAIS
// se cumuler (garde `attempts < 2` côté appelant).
function _postLongIsCold(r) {
  if (!r || r.needsCloudLogin) return false;
  if (r.error) return _isColdStart(0, r.error);
  const st = Number(r.status || 0);
  if (st === 402 || st === 429) return false;
  if (st >= 200 && st < 300) return false;
  return _isColdStart(st, r.json && r.json.error);
}

// Op mesh SYNC via POST /api/mesh-op — whitelist worker : smooth, decimate,
// center, fix_normals, fill_holes, subdivide, material, material_adjust,
// retex_swap, watertight, resize, explode. Télécharge le GLB résultat à
// outPath et renvoie l'URL R2 du résultat (à persister dans le sidecar du
// nouveau fichier pour le chaînage).
async function meshOp({ meshPath, opType, params = {}, outPath, projectName }) {
  let src = await resolveMeshUrl(meshPath);
  if (!src.success) return src;
  let attempts = 0;
  const call = (meshUrl) => {
    attempts++;
    return _authedPostLong('/api/mesh-op',
      { meshUrl, opType, params, ...(projectName ? { projectName } : {}) });
  };
  let r = await call(src.meshUrl);
  // Deux causes de rejeu possibles, jamais cumulées (2 appels réseau max) :
  // (a) URL signée du sidecar périmée/refusée → re-upload frais ;
  // (b) sinon cold start Modal (524/502/503/timeout) → attente puis rejeu.
  if (!r.needsCloudLogin && !r.error && !(r.status >= 200 && r.status < 300)
      && !src.uploaded && _staleUrlError(r.json && r.json.error, r.status)) {
    src = await resolveMeshUrl(meshPath, { forceUpload: true });
    if (!src.success) return src;
    r = await call(src.meshUrl);
  } else if (attempts < 2 && _postLongIsCold(r)) {
    _progress(`Cloud GPU is starting up (cold start), retrying in ${COLD_RETRY_DELAY_MS / 1000}s…`);
    await new Promise((res) => setTimeout(res, COLD_RETRY_DELAY_MS));
    r = await call(src.meshUrl);
    if (_postLongIsCold(r)) return { success: false, error: COLD_START_ERR };
  }
  if (r.needsCloudLogin) return { success: false, needsCloudLogin: true, error: 'Cloud session expired — please sign in again.' };
  if (r.error) return { success: false, error: r.error };
  const j = r.json || {};
  if (!(r.status >= 200 && r.status < 300) || j.success === false || j.ok === false) {
    return { success: false, error: _httpErr(r.status, j) };
  }
  const resultUrl = j.mesh_url || j.newPath || j.path || j.url;
  if (!resultUrl) return { success: false, error: 'no result url in worker response' };
  const dl = await _downloadTo(resultUrl, outPath, 500);
  if (!dl.success) return dl;
  return {
    success: true, newPath: outPath, resultUrl: _absUrl(String(resultUrl)),
    size: dl.size, stats: j.stats, creditsRemaining: j.creditsRemaining,
  };
}

// Démarrage d'un job ASYNC (POST court) → { jobId }.
async function startJob(startPath, body) {
  const a = await _authedFetch(startPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (a.needsCloudLogin) return { success: false, needsCloudLogin: true, error: 'Cloud session expired — please sign in again.' };
  const j = await a.resp.json().catch(() => ({}));
  const jobId = j.job_id || j.jobId || j.id;
  if (!a.resp.ok || j.success === false || !jobId) {
    return { success: false, error: _httpErr(a.resp.status, j) };
  }
  return { success: true, jobId, creditsRemaining: j.creditsRemaining };
}

// resolveMeshUrl + startJob avec retry upload frais si l'URL sidecar est
// refusée/périmée. bodyFor(meshUrl) construit le body de démarrage.
async function startMeshJob({ meshPath, startPath, bodyFor }) {
  let src = await resolveMeshUrl(meshPath);
  if (!src.success) return src;
  let r = await startJob(startPath, bodyFor(src.meshUrl));
  if (!r.success && !r.needsCloudLogin && !src.uploaded && _staleUrlError(r.error)) {
    src = await resolveMeshUrl(meshPath, { forceUpload: true });
    if (!src.success) return src;
    r = await startJob(startPath, bodyFor(src.meshUrl));
  }
  return r;
}

// Polling générique GET <statusPath>?job_id= (5 s, cap 15 min par défaut).
// done → télécharge la première URL trouvée dans urlKeys vers outPath.
async function pollJob({ statusPath, jobId, outPath, urlKeys = ['mesh_url', 'anim_url', 'url'],
                         onTick, intervalMs = 5000, capMs = 15 * 60 * 1000, minBytes = 500 }) {
  const t0 = Date.now();
  let polls = 0;
  let coldNoted = false;
  while (Date.now() - t0 < capMs) {
    await new Promise((res) => setTimeout(res, intervalMs));
    polls++;
    const a = await _authedFetch(`${statusPath}?job_id=${encodeURIComponent(jobId)}`);
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true, error: 'Cloud session expired — please sign in again.' };
    const js = await a.resp.json().catch(() => ({}));
    const st = String(js.status || js.state || '');
    try { onTick?.(st, polls, js); } catch (_) {}
    // Ops ASYNC : pas de retry (il démarrerait un second job payant), mais on
    // nomme le cold start pour que l'attente ne passe pas pour un blocage.
    if (!coldNoted && polls >= 8 && /queued|pending|starting/i.test(st)) {
      coldNoted = true;
      _progress('Cloud GPU is starting up (cold start) — this first run can take 2-3 minutes…');
    }
    if (/^done$|succeeded|completed/i.test(st)) {
      if (js.success === false) return { success: false, error: js.error || 'cloud job failed' };
      let resultUrl = null;
      for (const k of urlKeys) {
        const v = js[k];
        if (typeof v === 'string' && (/^https?:/i.test(v) || v.startsWith('/'))) { resultUrl = v; break; }
      }
      if (!resultUrl) return { success: false, error: 'job done but no result url in response' };
      const dl = await _downloadTo(resultUrl, outPath, minBytes);
      if (!dl.success) return dl;
      return { success: true, newPath: outPath, resultUrl: _absUrl(String(resultUrl)), resultKey: js.path, size: dl.size, raw: js };
    }
    if (/failed|^error$|canceled|cancelled/i.test(st)) {
      // Les crédits sont remboursés côté worker sur un job failed.
      return { success: false, error: js.error || `cloud job ${st}` };
    }
  }
  return { success: false, error: `cloud job timeout (${Math.round(capMs / 60000)} min)` };
}

// Études de construction 3D — POST /api/construction-stages-3d (SYNC mais
// LONG : ≥10 min de budget). materials : string (AUTO, un seul preset) ou
// objet {scaffold,frame,planks,formwork}. Télécharge chaque stage dans
// stagesDir/stage_<i>.glb (contrat check-stages3d-dir).
async function constructionStages3D({ meshPath, stageCount, materials, projectName, stagesDir }) {
  let src = await resolveMeshUrl(meshPath);
  if (!src.success) return src;
  let attempts = 0;
  const call = (meshUrl) => {
    attempts++;
    return _authedPostLong('/api/construction-stages-3d',
      { meshUrl, stageCount, materials, ...(projectName ? { projectName } : {}) },
      15 * 60 * 1000);
  };
  let r = await call(src.meshUrl);
  // Même garde qu'meshOp : URL périmée OU cold start, jamais les deux.
  if (!r.needsCloudLogin && !r.error && !(r.status >= 200 && r.status < 300)
      && !src.uploaded && _staleUrlError(r.json && r.json.error, r.status)) {
    src = await resolveMeshUrl(meshPath, { forceUpload: true });
    if (!src.success) return src;
    r = await call(src.meshUrl);
  } else if (attempts < 2 && _postLongIsCold(r)) {
    _progress(`Cloud GPU is starting up (cold start), retrying in ${COLD_RETRY_DELAY_MS / 1000}s…`);
    await new Promise((res) => setTimeout(res, COLD_RETRY_DELAY_MS));
    r = await call(src.meshUrl);
    if (_postLongIsCold(r)) return { success: false, error: COLD_START_ERR };
  }
  if (r.needsCloudLogin) return { success: false, needsCloudLogin: true, error: 'Cloud session expired — please sign in again.' };
  if (r.error) return { success: false, error: r.error };
  const j = r.json || {};
  if (!(r.status >= 200 && r.status < 300) || j.success === false || j.ok === false
      || !Array.isArray(j.stages) || !j.stages.length) {
    return { success: false, error: _httpErr(r.status, j) };
  }
  fs.mkdirSync(stagesDir, { recursive: true });
  const stages = [];
  for (let i = 0; i < j.stages.length; i++) {
    const s = j.stages[i];
    const su = (typeof s === 'string') ? s : (s && (s.url || s.path));
    if (!su) return { success: false, error: `stage ${i}: no url in worker response` };
    const sp = path.join(stagesDir, `stage_${i}.glb`);
    const dl = await _downloadTo(su, sp, 500);
    if (!dl.success) return { success: false, error: `stage ${i}: ${dl.error}` };
    stages.push({ index: i, path: sp });
  }
  return {
    success: true, stages, count: stages.length,
    versionUrl: j.versionMeshPath ? _absUrl(String(j.versionMeshPath)) : undefined,
    creditsRemaining: j.creditsRemaining,
  };
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
  if (!tok) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };

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

  // Seul le POST de DÉMARRAGE est protégé par le retry cold start : il ne
  // fait qu'enfiler le job (le routeur mesh de Modal est un dispatcher CPU),
  // donc un 502/503 ici signifie que rien n'a été dépensé. Le job lui-même
  // est ASYNC : un GPU froid s'y traduit par un statut « queued » qui dure,
  // pas par un 524 — le rejouer démarrerait un SECOND job payant.
  const startAttempt = async () => {
    let r;
    try {
      r = await fetch(`${WORKER_URL}/api/generate`, {
        method: 'POST',
        headers: { Cookie: `mfm-session=${tok}` },
        body: fd,
      });
    } catch (e) {
      return { success: false, error: String((e && e.message) || e), _httpStatus: 0 };
    }
    if (r.status === 401) { logout(); return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR }; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 402) {
      return { success: false, _httpStatus: 402, error: 'Not enough MyFabmesh credits. Top up on the website.' };
    }
    const id = j.jobId || j.job_id || j.id;
    if (!r.ok || !id) return { success: false, _httpStatus: r.status, error: j.error || `HTTP ${r.status}` };
    return { success: true, jobId: id };
  };
  const started = await _withColdRetry(startAttempt, { label: 'cloud 3D start' });
  if (!started.success) return started;
  const jobId = started.jobId;

  const t0 = Date.now();
  let polls = 0;
  let coldNoted = false;
  // 30 min et non 15 : meme raison que cote web (cf. POLL_TIMEOUT_MS dans
  // meshyAPI-cloud.js). La generation de maillage est l'operation la plus
  // longue du produit ; un prereglage eleve annonce deja ~9-10 min, auxquelles
  // s'ajoutent 2-3 min de demarrage a froid du conteneur Modal. Le job continue
  // cote serveur au-dela du plafond et les credits sont deja debites : abandonner
  // trop tot fait croire a une perte seche. Aligne sur le web le 2026-07-28.
  while (Date.now() - t0 < 30 * 60 * 1000) {
    await new Promise((res) => setTimeout(res, 4000));
    polls++;
    const a = await _authedFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
    const js = await a.resp.json().catch(() => ({}));
    const st = String(js.status || js.state || '');
    try { onProgress?.(st, polls); } catch (_) {}
    // Un GPU froid se voit ici comme un « queued » qui s'éternise : on
    // l'explique une fois plutôt que de laisser l'UI paraître figée.
    if (!coldNoted && polls >= 10 && /queued|pending|starting/i.test(st)) {
      coldNoted = true;
      _progress('Cloud GPU is starting up (cold start) — this first run can take 2-3 minutes…');
    }
    if (/succeeded|completed/i.test(st)) {
      const url = _findGlbUrl(js);
      if (!url) return { success: false, error: 'job succeeded but no GLB url in response' };
      // URL absolue hissée : renvoyée à l'appelant (glbUrl) pour être
      // persistée dans le sidecar (params.r2_url) → chaînage d'ops mesh
      // cloud sans re-upload (resolveMeshUrl la réutilise directement).
      const glbUrl = /^https?:/i.test(url) ? url : `${WORKER_URL}${url}`;
      const dl = await fetch(glbUrl, { headers: { Cookie: `mfm-session=${tok}` } });
      if (!dl.ok) return { success: false, error: `GLB download HTTP ${dl.status}` };
      const out = Buffer.from(await dl.arrayBuffer());
      if (out.length < 1000) return { success: false, error: 'GLB too small' };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
      return { success: true, meshPath: outPath, size: out.length, glbUrl };
    }
    if (/failed|error|canceled|cancelled/i.test(st)) {
      return { success: false, error: js.error || js.detail || `job ${st}` };
    }
  }
  // Message honnete : le job n'est PAS annule, il continue cote serveur et les
  // credits sont deja debites. Dire « timeout » tout court faisait croire a une
  // perte seche.
  return { success: false, error: 'La generation depasse 30 min de suivi. '
    + 'Elle CONTINUE sur le serveur : le resultat apparaitra dans le projet '
    + 'une fois termine. Aucun credit supplementaire ne sera debite.' };
}

async function listLibrary() {
  const a = await _authedFetch('/api/cloud-projects');
  if (a.needsCloudLogin) return { needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
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
    if (a.needsCloudLogin) return { success: false, needsCloudLogin: true, error: CLOUD_LOGIN_ERR };
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

// -----------------------------------------------------------------------------
// Préchauffage — POST /api/prewarm (le worker ping le /healthz du conteneur
// Modal text2image dans un waitUntil). Totalement « fire-and-forget » : jamais
// bloquant, jamais d'erreur remontée à l'UI. Le seul but est que le premier
// clic du testeur tombe sur un conteneur déjà démarré au lieu de payer les
// 2-3 min de cold start.
//
// Débounce client de 4 min, aligné sur la fenêtre « déjà chaud » du worker :
// sans lui, un utilisateur qui alt-tabbe en boucle facturerait des démarrages
// de GPU.
// -----------------------------------------------------------------------------
const PREWARM_DEBOUNCE_MS = 4 * 60 * 1000;
let _lastPrewarmMs = 0;
let _hbTimer = null;

async function prewarm({ imageOp = false, force = false } = {}) {
  if (!force && Date.now() - _lastPrewarmMs < PREWARM_DEBOUNCE_MS) {
    return { success: true, skipped: true };
  }
  _lastPrewarmMs = Date.now();
  try {
    const tok = await getAccessToken();
    if (!tok) return { success: false, needsCloudLogin: true };
    await fetch(`${WORKER_URL}/api/prewarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `mfm-session=${tok}` },
      body: JSON.stringify({ imageOp: !!imageOp }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch (_) { /* jamais visible par l'utilisateur */ }
  return { success: true };
}

// Battement de cœur : le cron du worker ne préchauffe QUE si un /api/heartbeat
// a été reçu dans les 5 dernières minutes (sinon un déploiement inactif
// démarrerait un GPU pour rien). Le desktop ne l'envoyait jamais — la porte
// était donc fermée en permanence. Endpoint gratuit et non authentifié.
function _startHeartbeat() {
  if (_hbTimer) return;
  const ping = async () => {
    try {
      if (_deps?.isCloudMode && !_deps.isCloudMode()) return;   // mode local : rien à chauffer
      if (!(await getAccessToken())) return;                    // pas de session : rien à chauffer
      await fetch(`${WORKER_URL}/api/heartbeat`, {
        method: 'POST', signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch (_) {}
  };
  _hbTimer = setInterval(ping, 2 * 60 * 1000);
  _hbTimer.unref?.();      // ne doit jamais retenir le process
  ping();
}

function register(deps) {
  _deps = deps;
  const { ipcMain } = deps;
  _startHeartbeat();
  ipcMain.handle('cloud-prewarm', async (_e, opts = {}) => {
    try { return await prewarm(opts || {}); }
    catch (e) { return { success: false, error: String(e.message || e) }; }
  });
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

module.exports = {
  register, generateImages, imageOp, generateMesh, getAccessToken, status, login, logout,
  // Cold start Modal : préchauffage à la demande + retry partagé
  prewarm,
  // Outils mesh mode Cloud (R2-reuse)
  resolveMeshUrl, uploadImage, meshOp, startJob, startMeshJob, pollJob, constructionStages3D,
};
