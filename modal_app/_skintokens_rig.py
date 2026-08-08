"""SkinTokens (TokenRig, VAST-AI, MIT) — rigging automatique sur Modal.

POURQUOI CETTE APP EXISTE
Le bureau est passé à SkinTokens le 2026-07-24 (verdict user : « marche bien
mieux que Puppeteer »), mais le CLOUD faisait toujours tourner Puppeteer.
Ce n'était pas qu'un écart de qualité : Puppeteer embarque **Michelangelo
(GPL-3.0)** et **PartField (NVIDIA non-commercial)**, un blocage commercial
identifié de longue date. Le produit payant tournait donc sur le moteur
abandonné pour raison de licence. SkinTokens est **MIT**.

L'écart avait échappé à l'audit de parité parce que les trois moteurs
portent le même libellé de-brandé « MyFabmesh.AI Rig » : une comparaison de
surface ne pouvait rien voir.

CONTRAT — identique à `_puppeteer_rig.py`, pour que le worker n'ait pas à
changer : `/healthz`, `/rig-start`, `/rig-status`, `/rig-fetch`, et le même
protocole par fichiers sur le volume (`<job>.glb` / `<job>.err`).

ATTENTION AU DEMARRAGE A FROID : les routes sont appelees SYNCHRONEMENT par
un worker Cloudflare, borne a 100 s de sous-requete. D'ou le decoupage
spawn + sondage : `/rig-start` rend la main en 1-2 s et le navigateur
interroge `/rig-status`.
"""
import json
import os
import subprocess
import tempfile
import time

import modal

SKINTOKENS_REPO = "https://github.com/VAST-AI-Research/SkinTokens.git"
SKINTOKENS_DIR = "/SkinTokens"

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-devel-ubuntu22.04", add_python="3.11"
    )
    # bpy (Blender comme module Python) charge des bibliotheques systeme des
    # l'import, meme sans jamais rendre d'image. Liste reprise TELLE QUELLE de
    # `blender_image` dans app.py, qui fonctionne en production — plutot que
    # de la deviner. Ma premiere version en oubliait quatre, et l'echec
    # remontait deforme : « wait_for_bpy_server » apres 30 s d'attente, alors
    # que la vraie cause etait « ImportError: libxkbcommon.so.0 » dans un
    # sous-processus dont la sortie n'etait pas rattachee.
    .apt_install(
        "git", "wget",
        "libgl1", "libglib2.0-0", "libsm6", "libxi6", "libxxf86vm1",
        "libxfixes3", "libxrender1", "libxkbcommon0", "libxext6",
    )
    # torch cu128 — meme famille que le poste du user (RTX 5080 sm_120), donc
    # meme chemin numerique que les rigs valides dans le comparateur.
    .pip_install(
        "torch==2.7.0", "torchvision==0.22.0",
        index_url="https://download.pytorch.org/whl/cu128",
    )
    .pip_install(
        "transformers>=4.57.0", "diffusers>=0.35.0", "python-box", "einops",
        "omegaconf", "lightning", "addict", "fast-simplification",
        "bpy>=4.2", "trimesh", "open3d", "huggingface_hub",
        "numpy>=1.26.0,<2", "fastapi[standard]", "requests==2.32.3",
        # `bottle` et `tornado` sont INDISPENSABLES, contrairement a ce que
        # j'avais suppose en les prenant pour des dependances de l'interface
        # web. `src/server/bpy_server.py` fait `from bottle import ...` et
        # `bottle.run(..., server='tornado')` : demo.py lance ce serveur en
        # sous-processus et l'interroge pour toutes les operations bpy. Sans
        # eux, le rig echoue sur `wait_for_bpy_server` apres 30 s d'attente —
        # constate en production.
        "bottle", "tornado",
        # `gradio`, en revanche, ne sert QUE a `demo.launch()` (mode web). On
        # ne l'installe pas, et son import est rendu paresseux plus bas.
    )
    .run_commands(
        f"git clone --depth 1 {SKINTOKENS_REPO} {SKINTOKENS_DIR}",
    )
    # ---- Patches SDPA : les MEMES que sur le poste du user -----------------
    # `flash_attention_2` exige une compilation de flash-attn (longue, et
    # bloquee par Smart App Control cote Windows). SDPA donne le meme
    # resultat sans dependance native — c'est la configuration sur laquelle
    # les 10 rigs de comparaison ont ete valides.
    .run_commands(
        f"sed -i 's/attn_implementation=\"flash_attention_2\"/attn_implementation=\"sdpa\"/' "
        f"{SKINTOKENS_DIR}/src/model/tokenrig.py",
        f"sed -i 's/_attn_implementation=\"flash_attention_2\"/_attn_implementation=\"sdpa\"/' "
        f"{SKINTOKENS_DIR}/src/server/spec.py",
        # Verification : un sed qui ne matche rien passe silencieusement et
        # on ne s'en apercevrait qu'a la premiere inference, en pleine
        # production. On echoue ici, au build.
        f"! grep -q 'flash_attention_2' {SKINTOKENS_DIR}/src/model/tokenrig.py",
        f"! grep -q 'flash_attention_2' {SKINTOKENS_DIR}/src/server/spec.py",
    )
    # ---- Import gradio rendu PARESSEUX ------------------------------------
    # demo.py fait `import gradio as gr` au niveau module, or on ne l'installe
    # pas. Sans ce patch, le simple import de demo.py echouerait alors que le
    # chemin CLI n'en a aucun besoin.
    .run_commands(
        f"sed -i 's/^import gradio as gr$/gr = None  # import paresseux : voir main()/' "
        f"{SKINTOKENS_DIR}/demo.py",
        f"sed -i 's/^gr.TEMP_DIR = \"tmp_gradio\"$//' {SKINTOKENS_DIR}/demo.py",
        f"! grep -q '^import gradio' {SKINTOKENS_DIR}/demo.py",
    )
    # ---- Shim SDPA pour `flash_attn_interface` -----------------------------
    # INDISPENSABLE, et je l'avais d'abord ecarte a tort en le croyant
    # specifique a Windows. `src/model/skin_vae_model.py:19` fait un import
    # DIRECT `from flash_attn_interface import flash_attn_func`, totalement
    # independant du reglage `attn_implementation` : les patches SDPA
    # ci-dessus ne le couvrent pas. Sans ce fichier, l'import de demo.py
    # echoue avec « No module named 'flash_attn_interface' » puis
    # « No module named 'flash_attn' » — constate en production.
    #
    # On reproduit le shim valide sur le poste du user : meme attention, via
    # `torch.scaled_dot_product_attention`, sans aucune compilation native.
    # flash_attn_func attend [B, S, H, D] la ou SDPA veut [B, H, S, D], d'ou
    # les transpositions ; FA-3 renvoie (out, softmax_lse), on rend
    # (out, None) car aucun appelant n'exploite le second element.
    .add_local_file(
        "external/SkinTokens/flash_attn_interface.py",
        remote_path=f"{SKINTOKENS_DIR}/flash_attn_interface.py",
        copy=True,          # copy=True : les etapes de build suivantes doivent le voir
    )
    .run_commands(
        # Verification au BUILD : l'import doit passer, sinon on echoue ici
        # plutot qu'au premier rig d'un utilisateur.
        f"cd {SKINTOKENS_DIR} && python -c \"from flash_attn_interface import "
        f"flash_attn_func; print('shim ok')\"",
    )
    # ---- Poids (1,6 Go) : dans l'IMAGE, pas au premier appel ---------------
    # Les telecharger a l'execution ferait payer 1,6 Go de reseau a chaque
    # demarrage a froid et exploserait le budget de 100 s du worker.
    .run_commands(
        f"cd {SKINTOKENS_DIR} && python download.py --model",
        secrets=[modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"])],
    )
    .add_local_python_source("modal_app")
)

app = modal.App("myfabmesh-skintokens", image=image)

rig_output_volume = modal.Volume.from_name(
    "myfabmesh-rig-output", create_if_missing=True,
)

CKPT = "experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt"


# ---------------------------------------------------------------------------
# Rigging (GPU)
# ---------------------------------------------------------------------------
@app.function(
    gpu="A10G",
    timeout=900,
    # ~22 s/maillage sur RTX 5080 ; l'A10G est plus lente, on garde de la
    # marge pour le chargement du modele au premier appel du conteneur.
    scaledown_window=300,
    volumes={"/rig_data": rig_output_volume},
    secrets=[modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"])],
)
def rig_mesh(glb_bytes: bytes, job_id: str | None = None) -> bytes:
    """Rig `glb_bytes` avec SkinTokens et renvoie le GLB riggé.

    Quand `job_id` est fourni, écrit aussi le résultat (ou l'erreur) sur le
    volume — c'est le seul point de synchronisation entre ce conteneur GPU et
    le routeur, qui tourne ailleurs.
    """
    t0 = time.time()
    tmp = tempfile.mkdtemp(prefix="skintokens_")
    src = os.path.join(tmp, "in.glb")
    out = os.path.join(tmp, "rigged.glb")
    with open(src, "wb") as f:
        f.write(glb_bytes)

    def _echec(msg: str):
        print(f"[skintokens] ECHEC : {msg}", flush=True)
        if job_id:
            with open(f"/rig_data/{job_id}.err", "w") as f:
                json.dump({"error": msg[:500]}, f)
            rig_output_volume.commit()
        raise RuntimeError(msg)

    # `--use_transfer` est VOLONTAIREMENT absent : il retargete la peau sur le
    # maillage source mais laisse le squelette dans l'espace normalise de
    # SkinTokens, d'ou des os flottant au-dessus du maillage. Exporter le
    # maillage propre du modele garde squelette et geometrie dans le meme
    # repere — c'est la configuration validee dans le comparateur.
    cmd = ["python", "demo.py", "--input", src, "--output", out]
    print(f"[skintokens] {' '.join(cmd)}", flush=True)
    proc = subprocess.Popen(
        cmd, cwd=SKINTOKENS_DIR,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    # On CONSERVE la fin de la sortie : la premiere version affichait un
    # message generique (« objets mecaniques refuses ») pour ce qui etait en
    # realite une erreur d'import. Un message qui explique le mauvais
    # probleme coute un aller-retour de diagnostic complet.
    dernieres = []
    for line in iter(proc.stdout.readline, ""):
        if line.strip():
            print(line.rstrip(), flush=True)
            dernieres.append(line.rstrip())
            if len(dernieres) > 12:
                dernieres.pop(0)
    proc.stdout.close()
    rc = proc.wait()

    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        queue = " | ".join(dernieres[-4:])[:300]
        _echec(
            f"SkinTokens n'a produit aucun fichier (rc={rc}). "
            f"Derniere sortie : {queue}"
        )

    data = open(out, "rb").read()
    print(f"[skintokens] TERMINE en {time.time()-t0:.1f}s — {len(data)} octets", flush=True)

    if job_id:
        with open(f"/rig_data/{job_id}.glb", "wb") as f:
            f.write(data)
        rig_output_volume.commit()
    return data


# ---------------------------------------------------------------------------
# Routeur ASGI — contrat identique a _puppeteer_rig.py
# ---------------------------------------------------------------------------
@app.function(
    timeout=120,
    volumes={"/rig_data": rig_output_volume},
    secrets=[modal.Secret.from_name("myfabmesh-shared", required_keys=["SHARED_SECRET"])],
)
@modal.asgi_app()
def rig_router():
    """Expose /healthz, /rig-start, /rig-status et /rig-fetch.

    SANS GPU, volontairement : le worker Cloudflare appelle ces routes
    synchronement sous une limite de 100 s. Un routeur sur GPU ferait payer
    un reveil de carte a chaque sondage de statut.
    """
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse, Response

    api = FastAPI(title="myfabmesh-skintokens")

    async def _json(request: Request) -> dict:
        try:
            return await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="invalid JSON body")

    def _auth(payload: dict) -> None:
        attendu = os.environ.get("SHARED_SECRET", "")
        fourni = (payload or {}).get("_auth") or ""
        if not attendu or fourni != attendu:
            raise HTTPException(status_code=401, detail="unauthorized")

    @api.get("/healthz")
    async def healthz():
        return {"ok": True, "fn": "rig_router", "engine": "skintokens"}

    @api.post("/rig-start")
    async def rig_start(request: Request):
        payload = await _json(request)
        _auth(payload)
        op = (payload.get("op_type") or "rig").strip().lower()

        if op == "cancel":
            job_id = (payload.get("job_id") or "").strip()
            if not job_id:
                raise HTTPException(status_code=400, detail="job_id required for cancel")
            try:
                with open(f"/rig_data/{job_id}.call_id") as f:
                    call_id = f.read().strip()
                modal.functions.FunctionCall.from_id(call_id).cancel()
                return JSONResponse({"cancelled": True, "job_id": job_id})
            except Exception as e:
                return JSONResponse({"cancelled": False, "error": str(e)[:200]})

        mesh_url = (payload.get("mesh_url") or "").strip()
        if not mesh_url:
            raise HTTPException(status_code=400, detail="mesh_url required")

        import urllib.request
        import uuid
        job_id = (payload.get("job_id") or "").strip() or uuid.uuid4().hex
        try:
            req = urllib.request.Request(mesh_url, headers={"User-Agent": "myfabmesh"})
            with urllib.request.urlopen(req, timeout=90) as r:
                glb = r.read()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"mesh download failed: {e}")

        appel = rig_mesh.spawn(glb, job_id)
        try:
            with open(f"/rig_data/{job_id}.call_id", "w") as f:
                f.write(appel.object_id)
            rig_output_volume.commit()
        except Exception:
            pass                      # l'annulation sera indisponible, pas le rig
        return JSONResponse({"job_id": job_id, "status": "queued"})

    @api.post("/rig-status")
    async def rig_status(request: Request):
        payload = await _json(request)
        _auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")
        # Rechargement OBLIGATOIRE : rig_mesh tourne dans un AUTRE conteneur,
        # le volume est le seul point de synchronisation.
        rig_output_volume.reload()
        err = f"/rig_data/{job_id}.err"
        glb = f"/rig_data/{job_id}.glb"
        if os.path.isfile(err):
            brut = open(err).read()
            msg = brut
            try:
                p = json.loads(brut)
                if isinstance(p, dict) and p.get("error"):
                    msg = str(p["error"])
            except Exception:
                pass
            return JSONResponse({"ready": False, "error": msg[:500]})
        if os.path.isfile(glb):
            return JSONResponse({
                "ready": True,
                "bytes": os.path.getsize(glb),
                "fetch_endpoint": "/rig-fetch",
            })
        return JSONResponse({"ready": False})

    @api.post("/rig-fetch")
    async def rig_fetch(request: Request):
        """Renvoie les octets bruts. On ne passe PAS par du base64 en JSON :
        un GLB de 60 Mo encodé faisait exploser la limite de 128 Mo du worker
        Cloudflare (leçon déjà payée sur l'app Puppeteer)."""
        payload = await _json(request)
        _auth(payload)
        job_id = (payload.get("job_id") or "").strip()
        if not job_id:
            raise HTTPException(status_code=400, detail="job_id required")
        rig_output_volume.reload()
        if os.path.isfile(f"/rig_data/{job_id}.err"):
            raise HTTPException(status_code=410, detail="rig failed")
        chemin = f"/rig_data/{job_id}.glb"
        if not os.path.isfile(chemin):
            raise HTTPException(status_code=404, detail="not ready")
        return Response(content=open(chemin, "rb").read(),
                        media_type="model/gltf-binary")

    return api
