# MyFabmesh.AI — Shipping Checklist

Étapes ordonnées pour passer de "installer prototype" à "installer commercialisable".

> **Naming** : produit = **MyFabmesh.AI**, nom court technique = `MyFabmesh`, domain principal = `myfabmesh.ai` (acheté Phase 1 quand budget OK).

---

## ✅ Déjà fait

- [x] Wizard 5 étapes fonctionnel
- [x] Hardware detection auto
- [x] electron-builder NSIS configuré
- [x] Installer prototype généré (`dist/installer/FabMesh-Setup-1.0.0.exe`, 142 MB)
- [x] Python 3.11.9 portable bundled
- [x] VC++ 2022 redist bundled
- [x] HF token fallback dans wizard_download.py
- [x] Boutons Cancel/Reconfigure/Uninstall
- [x] UI anonymisée (FabMesh 3D Core, etc.)
- [x] `wizard_install_deps.py` simplifié — utilise les wheels officiels PyTorch + PyPI directement (plus de R2 requis pour Phase 1)

---

## 🚧 Avant de pouvoir vendre — checklist ordonnée

### Étape 1 — Générer un token HuggingFace read-only (5 min)

**Pourquoi** : si HF rate-limite les downloads anonymes (ça arrive sur les gros repos), avoir un token permet à l'app de continuer à fonctionner.

1. Va sur https://huggingface.co/join (compte gratuit)
2. Settings → Access Tokens → New token
3. Type : **Read** uniquement (jamais Write — on n'a rien à pousser)
4. Nom : `fabmesh-fallback-readonly`
5. Copie le token `hf_xxxxxxxxx...`
6. Édite `scripts/wizard_download.py` ligne ~32 :
   ```python
   HF_FALLBACK_TOKEN = 'hf_xxxxxxxxxxxxxxxxxxxxxxx'
   ```
7. Re-build l'installer : `npm run build:installer`

Le token sera embedded dans le binaire. Risque sécurité : nul, c'est read-only public.

---

### Étape 2 — Code signing certificate (2 jours paperasse, 200€/an)

**Pourquoi** : sans signature, Windows Defender affiche "Unknown publisher — ne pas exécuter". 30% des users abandonnent à ce stade.

**Options par ordre de simplicité** :

| Fournisseur | Type | Prix/an | Délai | Recommandation |
|---|---|---|---|---|
| **Sectigo OV** | Organization Validation | ~200€ | 2-7 jours | ✅ Bon rapport qualité/prix |
| Sectigo EV | Extended Validation | ~330€ | 5-10 jours | ⚠ Pas nécessaire en Phase 1 |
| SSL.com OV | OV équivalent | ~190€ | 2-5 jours | Bon backup |
| Certum OV | Pologne, moins cher | ~80€ | 5-10 jours | Pour budget serré |

**Procédure** :
1. Achète chez Sectigo : https://sectigo.com/ssl-certificates-tls/code-signing
2. Fournis les documents : Kbis / extrait Sirene de ton auto-entreprise + ID
3. Reçois le certificat dans 2-7 jours
4. Importe-le dans Windows (clic droit → Installer)
5. Édite `package.json` build :
   ```json
   "win": {
     "signtoolOptions": {
       "publisherName": "Ton nom légal",
       "certificateSubjectName": "Ton nom légal exact dans le cert",
       "signingHashAlgorithms": ["sha256"]
     }
   }
   ```
6. Re-build : `npm run build:installer` → l'installer sera signé automatiquement

---

### Étape 3 — Achat domain + landing page (1 jour)

1. **Acheter `myfabmesh.ai`** chez Namecheap (~70€/an) ou OVH — c'est le domain principal car le `.AI` fait partie de la brand
2. **Setup Cloudflare** (gratuit) :
   - Ajouter le domain
   - Activer SSL automatique
   - Activer le cache CDN
3. **Déployer la landing** :
   - Vercel (gratuit) ou Netlify
   - Site statique Next.js / Astro
   - Auto-deploy depuis GitHub push

La landing doit avoir :
- 2 cartes Desktop / Cloud
- Specs visibles
- Bouton "Check compatibility" qui mène à `/check`
- Liens vers Fab.com / itch.io / Gumroad

---

### Étape 4 — Compatibility checker web (1 semaine)

Composant React qui :
1. Lit `WebGL.UNMASKED_RENDERER` → nom GPU
2. Lookup dans une DB JSON (~500 GPUs courants → VRAM estimée)
3. Lit `navigator.hardwareConcurrency` / `navigator.deviceMemory` / `userAgent`
4. Verdict : ✓ Full / ⚠ Lite / ✗ Cloud
5. Bouton "Buy Desktop" ou "Try Cloud" selon résultat

Structure :
```
/components/CompatibilityChecker.tsx
/data/gpu-database.json         (~500 entries)
/api/check-result               (Supabase pour stats)
```

Optionnel : binaire `.exe` Go (5 MB) pour un check plus précis (lit nvidia-smi réel, envoie résultat au site via token éphémère).

---

### Étape 5 — Tests sur 8 machines variées (1 semaine)

Test matrix obligatoire :

| Config | Test |
|---|---|
| Ton PC dev (RTX 5080 16GB) | ✓ Mode Full |
| Laptop ami RTX 3060 12GB | ✓ Mode Standard |
| Vieux PC GTX 1660 6GB | ⚠ Mode Lite (limite) |
| PC bureau sans dGPU (UHD) | ✗ Refus → Cloud |
| PC AMD RX 6700 | ✗ Refus → Cloud |
| Win 10 VM fresh | ✓ Install propre |
| Win 11 VM fresh | ✓ Install propre |
| PC avec Python système 3.12 | ✓ Pas de conflit |

Si les 8 passent → tu peux release. Sinon documenter les fix.

---

### Étape 6 — Listing stores (2 jours)

**Préparer les assets** :
- 5 captures d'écran 1920x1080
- 1 trailer YouTube 90s (montrer image → mesh dans Blender/Unreal en 3 min)
- Logo 512x512
- Description courte (200 mots) + longue (1000 mots)
- Liste features

**Listings** :
1. **Fab.com** (Epic) : compte créateur + soumission (review ~7-14 jours)
2. **itch.io** : live immédiat
3. **Gumroad** : live immédiat
4. **myfabmesh.ai** : Stripe Checkout intégré (ou subdomain itch.io en Phase 0 zéro budget)

---

### Étape 7 — Beta privée 2 semaines avant public launch

- Listing Gumroad **unlisted** à 12,99€ (vs 24,99€ public)
- Email à ta mailing list / followers Discord
- Récolte feedback intense
- Patch 1x tous les 2-3 jours
- Témoignages utilisables

---

### Étape 8 — Public launch

**Jour J** (un mardi ou mercredi, 9h ET) :
1. Annonce Product Hunt (préparé 1 semaine en amont)
2. Show HN: post Hacker News
3. Reddit blast coordonné (r/unrealengine, r/blender, r/IndieDev, r/gamedev)
4. Email blast mailing list : "-30% les 24h"
5. Twitter thread (8-12 tweets avec GIFs)
6. Indie Hackers post

---

## Récap effort total avant release

| Étape | Effort solo |
|---|---|
| 1. Token HF | 5 min |
| 2. Code signing cert | 2 jours paperasse + attente |
| 3. Domain + landing | 1 jour |
| 4. Compatibility checker web | 1 semaine |
| 5. Tests 8 machines | 1 semaine |
| 6. Listing stores + assets | 2 jours |
| 7. Beta privée | 2 semaines |
| 8. Public launch | 1 jour |
| **Total** | **~4-5 semaines** |

## Coût total avant 1ère vente

| Poste | Montant |
|---|---|
| Domain myfabmesh.ai (principal) | 70 € |
| Domain myfabmesh.com (backup, redirige) | 12 € |
| Code signing cert Sectigo (1 an) | 200 € |
| Steamworks (optionnel) | N/A (on ne va pas sur Steam) |
| Vercel/Netlify hosting | 0 € |
| Cloudflare DNS + CDN | 0 € |
| Compte HuggingFace | 0 € |
| Test machines | 0 € (perso) ou 50 € (cloud VM) |
| **Total** | **~210-260 €** |

ROI break-even : ~10 ventes à 24,99 €.
