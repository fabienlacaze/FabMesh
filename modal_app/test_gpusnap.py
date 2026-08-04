"""TEST ISOLE — le snapshot GPU permet-il de photographier TRELLIS-2 charge ?

POURQUOI CE FICHIER EXISTE
La classe de maillage de production tourne avec `enable_memory_snapshot=False`,
et le commentaire du code en donne la raison : l'IMPORT de trellis2 declenche
des `@triton_autotune` au niveau module, qui appellent
`driver.active.get_benchmarker()` — sans GPU cela echoue avec « 0 active
drivers ». Or un snapshot memoire classique se prend SANS GPU. D'ou les
211 s de rechargement complet a chaque demarrage a froid, mesurees le
2026-08-04, pour 130 s de calcul utile.

Le snapshot GPU (`experimental_options={"enable_gpu_snapshot": True}`,
present dans modal 1.4.3) prend la photo AVEC un GPU attache. C'est
exactement la levee du blocage — en theorie.

ON NE TOUCHE PAS A LA PRODUCTION. Ce fichier declare sa PROPRE app
(`myfabmesh-gpusnap-test`) : si le drapeau experimental empeche les
conteneurs de demarrer, seule cette app casse. La classe de production
reste intacte tant que le test n'a pas tranche.

USAGE
    modal deploy modal_app/test_gpusnap.py
    modal run   modal_app/test_gpusnap.py::mesurer     # 1er appel : cree le snapshot
    modal run   modal_app/test_gpusnap.py::mesurer     # 2e appel : restaure

Ce qu'on lit : le `duree_chargement_s` du DEUXIEME appel. S'il tombe bien
en dessous des 211 s de reference, le snapshot GPU fonctionne.
"""
import os
import sys
import time

import modal

# On reutilise TELLE QUELLE l'image de production : tester sur une image
# differente ne prouverait rien sur le cas reel.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import mesh_image  # noqa: E402

app = modal.App("myfabmesh-gpusnap-test")


@app.cls(
    image=mesh_image,
    gpu="L40S",
    timeout=900,
    scaledown_window=60,          # test : on ne veut pas payer de traine
    enable_memory_snapshot=True,
    # LE DRAPEAU TESTE. Sans lui, le `snap=True` ci-dessous echouerait a
    # l'import faute de GPU pendant la prise du snapshot.
    experimental_options={"enable_gpu_snapshot": True},
    secrets=[
        modal.Secret.from_name("huggingface", required_keys=["HF_TOKEN"]),
    ],
)
class SnapshotGpuTest:
    @modal.enter(snap=True)
    def charger(self):
        """Copie fidele du chargement de production, mais en phase SNAPSHOT.

        C'est precisement ce que la production declare impossible. Si cette
        methode passe, le blocage documente est leve."""
        t0 = time.time()
        print("[test] import trellis2 + chargement TRELLIS.2-4B…", flush=True)
        sys.path.insert(0, "/opt/trellis2_local")
        os.environ.setdefault("TRELLIS2_USE_KAOLIN_RASTER", "1")
        os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
        os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
        os.environ.setdefault("TORCHINDUCTOR_USE_TRITON", "0")
        os.environ.setdefault("TRANSFORMERS_ATTN_IMPLEMENTATION", "eager")

        # Meme correctif de cache que la production (RMBG-2.0 est sous licence
        # fermee, on lui substitue BiRefNet, Apache 2.0).
        try:
            from huggingface_hub import snapshot_download
            racine = snapshot_download("microsoft/TRELLIS.2-4B",
                                       allow_patterns=["pipeline.json"])
            chemin = os.path.join(racine, "pipeline.json")
            if os.path.isfile(chemin):
                with open(chemin, "r", encoding="utf-8") as f:
                    contenu = f.read()
                if "briaai/RMBG-2.0" in contenu:
                    with open(chemin, "w", encoding="utf-8") as f:
                        f.write(contenu.replace("briaai/RMBG-2.0",
                                                "ZhengPeng7/BiRefNet"))
        except Exception as e:
            print(f"[test] correctif rmbg ignore : {e}", flush=True)

        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        self.pipeline = Trellis2ImageTo3DPipeline.from_pretrained(
            "microsoft/TRELLIS.2-4B")
        self.pipeline.rembg_model = None
        self.pipeline.cuda()
        self.duree = time.time() - t0
        print(f"[test] chargement + passage GPU en {self.duree:.1f}s", flush=True)

    @modal.method()
    def mesurer(self) -> dict:
        import torch
        return {
            "duree_chargement_s": round(self.duree, 1),
            "reference_production_s": 211.6,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "vram_utilisee_Go": round(torch.cuda.memory_allocated() / 2**30, 2)
            if torch.cuda.is_available() else None,
        }


@app.local_entrypoint()
def mesurer():
    r = SnapshotGpuTest().mesurer.remote()
    print()
    print("=== RESULTAT ===")
    for k, v in r.items():
        print(f"  {k:26} {v}")
    ref = r.get("reference_production_s") or 0
    d = r.get("duree_chargement_s") or 0
    if d and ref:
        print()
        if d < ref * 0.5:
            print(f"  => SNAPSHOT GPU EFFICACE : {ref:.0f}s -> {d:.0f}s "
                  f"({(1 - d / ref) * 100:.0f}% de gain)")
        else:
            print(f"  => pas de gain net ({d:.0f}s contre {ref:.0f}s de reference)")
