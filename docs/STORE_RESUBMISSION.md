# Resoumission Microsoft Store — checklist (rapport de certification du 23/07/2026)

Rapport : Partner Center → MyFabmesh.AI (Product ID 9PH6GT8XKQDW) → Certification report.
Deux échecs à corriger avant resoumission.

## 1. 10.8.2 — Achats in-app (« Credits ») — ACTION MANUELLE PARTNER CENTER ⚠️

Microsoft a détecté la vente de crédits hors de leur système de paiement.
Il faut **déclarer** ce comportement (pas le supprimer) :

1. Partner Center → MyFabmesh.AI → **créer une nouvelle soumission**
2. Section **Properties** → **Product Declarations**
3. Cocher : **« This app allows users to make purchases, but does not use
   the Microsoft Store commerce system »**
4. Sauvegarder. (La mention apparaîtra sous le bouton « Get » de la fiche.)

Réf : https://docs.microsoft.com/en-us/windows/uwp/publish/product-declarations

## 2. 10.1.2.10 — « Picture creation from AI » inutilisable — CORRIGÉ CÔTÉ CODE ✅

Cause racine : les testeurs MS utilisent des **Surface Laptop (aucun GPU
NVIDIA)**. Les moteurs d'images de l'app étaient 100 % locaux CUDA → la
fonctionnalité principale était physiquement intestable chez eux (et chez
la majorité des clients du Store).

Correctif implémenté (voir `src/main/main.js`) :
- **Détection GPU au démarrage** (`detectNvidiaGpu()`, cache session,
  IPC `gpu-status`).
- **Sans GPU NVIDIA → fallback automatique sur le cloud MyFabmesh** pour la
  génération d'images (mêmes projets, mêmes fichiers en sortie). L'UI ne
  change pas : le testeur clique « Générer », ça marche.
- Avec GPU NVIDIA → comportement local inchangé.

## 3. Avant de resoumettre (rappels)

- [ ] Cocher la déclaration 10.8.2 (point 1 ci-dessus)
- [ ] **Test d'installation réelle** du package sur machine propre
      (~5 Go, premier lancement, téléchargement des modèles) — resté à
      faire depuis la remédiation MSIX
- [ ] Vérifier le fallback cloud sur une machine SANS GPU NVIDIA
      (ou en simulant : renommer nvidia-smi / `FABMESH_FORCE_NO_GPU=1`)
- [ ] Configuration matérielle recommandée dans la fiche Store :
      mentionner « GPU NVIDIA (8 Go VRAM) recommandé pour la génération
      3D locale ; la création d'images fonctionne sans GPU (cloud) »
- [ ] Soumission MANUELLE via Partner Center (l'API Azure AD de
      soumission est morte — compte MSA Graph, constaté en juillet)
- [ ] Audit de release 7 dimensions (règle projet) si version publique
