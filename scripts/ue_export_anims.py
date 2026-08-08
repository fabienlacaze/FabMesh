"""Export FBX des animations apovivor — a executer DANS l'editeur Unreal.

OBJECTIF
Sortir les squelettes et animations des packs (Loup en premier) vers des FBX
lisibles hors Unreal, pour les retargeter sur les squelettes generes par
SkinTokens (decision user du 2026-08-08 : le squelette reste celui de
SkinTokens, les banques apovivor/Mesh2Motion servent a l'animer).

GARANTIES
- LECTURE SEULE sur le projet : aucun asset modifie, aucun fichier ecrit dans
  D:\\apovivor512.15. Les FBX sortent dans C:\\tmp\\apovivor_fbx.
- Usage personnel uniquement (licence Fab : pas de redistribution).

COMMENT L'EXECUTER (deux options)
  A. Editeur ouvert : Window > Developer Tools > Output Log, puis dans la
     ligne de commande en mode Python :
         exec(open(r"c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/ue_export_anims.py").read())
  B. Sans interface (plus long a demarrer) :
         "C:\\Program Files\\Epic Games\\UE_5.X\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe" ^
             "D:\\apovivor512.15\\apovivor.uproject" ^
             -run=pythonscript -script="c:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/scripts/ue_export_anims.py"

Par defaut : uniquement les assets dont le chemin contient FILTRE ("Wolf").
Mettre FILTRE = "" pour tout exporter (~504 animations, long).
"""
import os

import unreal

RACINE = "/Game/1_Actors/Animals/1_Source"
SORTIE = r"C:\tmp\apovivor_fbx"
FILTRE = "Wolf"          # "" = tout exporter

os.makedirs(SORTIE, exist_ok=True)
registre = unreal.AssetRegistryHelpers.get_asset_registry()
chemins = unreal.EditorAssetLibrary.list_assets(RACINE, recursive=True, include_folder=False)

exportes, rates = [], []
for chemin in chemins:
    if FILTRE and FILTRE.lower() not in str(chemin).lower():
        continue
    donnee = unreal.EditorAssetLibrary.find_asset_data(chemin)
    classe = str(donnee.asset_class_path.asset_name) if donnee.is_valid() else ""
    # AnimSequence UNIQUEMENT. L'export d'un SkeletalMesh plante l'editeur
    # sans interface (assertion SkinnedMeshComponent.cpp:4677, constate) et
    # tuait la boucle avant les autres assets. Le squelette est de toute
    # facon present dans chaque FBX d'animation.
    if classe not in ("AnimSequence",):
        continue
    asset = donnee.get_asset()
    nom = str(donnee.asset_name)
    sous = "meshes" if classe == "SkeletalMesh" else "anims"
    dossier = os.path.join(SORTIE, sous)
    os.makedirs(dossier, exist_ok=True)
    fbx = os.path.join(dossier, nom + ".fbx")

    options = unreal.FbxExportOption()
    options.ascii = False
    options.export_morph_targets = False
    options.export_preview_mesh = False
    # Le maillage N'EST PAS embarque dans les FBX d'animation : seul le
    # squelette anime nous interesse, et les fichiers restent legers.
    options.level_of_detail = False

    tache = unreal.AssetExportTask()
    tache.object = asset
    tache.filename = fbx
    tache.automated = True
    tache.replace_identical = True
    tache.prompt = False
    tache.options = options

    ok = unreal.Exporter.run_asset_export_task(tache)
    (exportes if ok and os.path.isfile(fbx) else rates).append((classe, nom))
    if ok:
        unreal.log("exporte : %s -> %s" % (nom, fbx))
    else:
        unreal.log_warning("ECHEC : %s" % chemin)

unreal.log("=== %d exportes, %d rates -> %s ===" % (len(exportes), len(rates), SORTIE))
for c, n in rates:
    unreal.log_warning("  rate : %s %s" % (c, n))
