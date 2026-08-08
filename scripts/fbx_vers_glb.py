"""Convertit des FBX d'animation (exports Unreal) en GLB — via bpy.

POURQUOI CE DETOUR
Le retargeting de FabMesh (`retarget_motion_to_rig`) et le lecteur de clips
(`mesh2motion_bridge.lire_clip`) consomment du glTF. Plutot que d'ecrire un
lecteur FBX, on convertit une fois pour toutes avec l'importateur FBX de
Blender — deja present dans le venv SkinTokens. Les noms d'os et les courbes
d'animation sont preserves, et toute la chaine aval reste inchangee.

A executer avec le python du venv SkinTokens (bpy inclus) :
    C:/tmp/skv/Scripts/python.exe scripts/fbx_vers_glb.py <dossier_fbx> <dossier_glb>
"""
import os
import sys

import bpy

SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\tmp\apovivor_fbx\anims"
DST = sys.argv[2] if len(sys.argv) > 2 else r"C:\tmp\apovivor_fbx\glb"

os.makedirs(DST, exist_ok=True)
fbx = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".fbx"))
print("%d FBX a convertir" % len(fbx), flush=True)

ok, rates = 0, []
for nom in fbx:
    sortie = os.path.join(DST, os.path.splitext(nom)[0] + ".glb")
    if os.path.isfile(sortie):
        ok += 1
        continue
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=os.path.join(SRC, nom))
        bpy.ops.export_scene.gltf(
            filepath=sortie,
            export_format="GLB",
            export_animations=True,
            export_skins=True,
            # ECHANTILLONNER toutes les images : les courbes UE utilisent des
            # interpolations que le glTF ne represente pas toutes ; le
            # reechantillonnage garantit la fidelite, au prix du poids.
            export_force_sampling=True,
            export_materials="NONE",
        )
        ok += 1
        print("  %s" % nom, flush=True)
    except Exception as e:
        rates.append((nom, str(e)[:120]))
        print("  ECHEC %s : %s" % (nom, str(e)[:120]), flush=True)

print("TERMINE : %d convertis, %d rates" % (ok, len(rates)), flush=True)
