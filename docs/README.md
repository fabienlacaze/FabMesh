# MyFabmesh.AI — site web

Site statique zéro-budget pour [MyFabmesh.AI](https://fabienlacaze.github.io/FabMesh/).

Composé de :
- `index.html` — landing avec 2 cards (Desktop / Cloud) + How it works + FAQ
- `check.html` — compatibility checker browser-based (5 sec)
- `gpu-database.js` — DB de ~100 GPU avec leur VRAM (NVIDIA / AMD / Intel)
- `check.js` — logique du checker (WebGL + lookup + verdict)
- `styles.css` — design system (mêmes couleurs que l'app desktop pour cohérence)
- `favicon.png` — placeholder, à remplacer

**Stack** : HTML + CSS + JS pur. Aucun build, aucune dépendance npm. On ouvre `index.html` en local, ça marche.

---

## Déploiement sur GitHub Pages (zéro coût, 5 min)

### Étape 1 — Push le contenu sur GitHub

Les fichiers de `website/` sont déjà dans le repo. Reste à pousser :

```bash
git push origin master
```

### Étape 2 — Activer GitHub Pages

Sur https://github.com/fabienlacaze/FabMesh/settings/pages :

1. **Source** : "Deploy from a branch"
2. **Branch** : `master`
3. **Folder** : `/website` (pas la racine — c'est ce qu'on veut servir)
4. Save

Après ~30 sec, le site est live à :
**`https://fabienlacaze.github.io/FabMesh/`**

### Étape 3 — Tester

Ouvre l'URL dans Chrome / Firefox. La landing s'affiche, clique sur "Check my PC" pour tester le compatibility checker. La détection GPU/VRAM/OS s'affiche en ~1 seconde.

---

## Plus tard : domain custom (myfabmesh.ai)

Quand tu auras les sous (~70€/an pour le `.ai`) :

1. Achète `myfabmesh.ai` sur Namecheap, OVH ou Cloudflare Registrar
2. Dans le DNS du registrar, ajoute un CNAME :
   ```
   Type:  CNAME
   Name:  @  (ou www, ou les deux)
   Value: fabienlacaze.github.io
   ```
3. Crée un fichier `website/CNAME` avec une seule ligne :
   ```
   myfabmesh.ai
   ```
4. Push, et dans Settings → Pages, ajoute `myfabmesh.ai` comme domain custom
5. Cocher "Enforce HTTPS" (gratuit via Let's Encrypt automatique)

Total surcoût après Phase 0 = 70€/an pour avoir un domain propre.

---

## Local preview

Pas besoin de serveur — ouvrir simplement `index.html` dans le navigateur fonctionne.

Si tu veux quand même un mini-serveur local (utile pour `fetch` ou des paths absolus) :

```bash
cd website
python -m http.server 8000
# puis : http://localhost:8000
```

---

## Personnaliser

| Fichier | Modifier pour |
|---|---|
| `index.html` | Le texte de la home, des cards, de la FAQ |
| `check.html` | Le texte de la page de check |
| `check.js` | La logique de verdict (seuils VRAM, OS supportés) |
| `gpu-database.js` | Ajouter des GPU manquants |
| `styles.css` | Couleurs, typographie, layout |

Aucune build step, aucun framework. Ouvre le fichier, édite, push.

---

## TODO (quand on aura le budget)

- [ ] Remplacer `favicon.png` placeholder par un vrai logo
- [ ] Acheter et configurer `myfabmesh.ai`
- [ ] Activer Plausible ou Cloudflare Analytics (gratuit) pour mesurer le trafic
- [ ] Ajouter les vrais liens Stripe / Gumroad / Fab.com sur les boutons "Buy"
- [ ] Implementer la page `cloud-soon.html` ou rediriger vers cloud.myfabmesh.ai (Phase 2)
- [ ] Binaire diagnostic `.exe` Go (5 MB) pour un check plus précis qu'en browser
