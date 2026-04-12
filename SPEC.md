# FabMesh — Specification

## Ce que l'app fait

1. **Image** depuis un prompt texte
2. **Mesh 3D texturé** depuis une image (fidèle à l'image, debout, propre)
3. **Auto-rig + animations** pour les characters (compatible Unreal Engine 5)
4. **Édition d'images** (img2img, inpaint, remove bg)

## Contraintes non-négociables

- **Gratuit et commercialisable** (Steam) — MIT, Apache 2.0, CreativeML OK.
  Pas de non-commercial, pas de limite revenus, pas de restrictions territoriales.
- **100% local** — pas de cloud, pas d'API payante
- **Textures fidèles à l'image source** — pas de mesh blanc, pas de couleurs aléatoires

## UX

- UI projet-based (un projet = images + meshes + rigs)
- Workspace 3 étapes : Image → 3D → Rig
- Versioning
- Limites matérielles (VRAM, RAM, GPU%) respectées
- Popups claires en cas d'erreur

## Distribution

- **Installer Steam** léger (~200 MB) qui télécharge les deps au premier lancement
- **Aucune install manuelle** pour l'utilisateur final
- **Pas de build C++** côté user (wheels pré-compilés uniquement)
- Tourne sur RTX 30/40/50 avec 8 GB+ VRAM
