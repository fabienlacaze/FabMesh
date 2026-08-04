"""Audit des marges : ce qui est MESURE contre ce qui est SUPPOSE.

Regle du jeu : on ne prend AUCUN chiffre du code pour argent comptant. Les
prix viennent de la grille R2 reellement servie, les couts viennent de la
facture Modal quand ils ont ete mesures — et quand ils ne l'ont pas ete, on
le DIT au lieu de faire passer une supposition pour une mesure.

La contrainte est le pack le plus DEFAVORABLE : c'est lui qui doit tenir,
sinon les meilleurs clients sont les plus deficitaires.
"""
import io
import json
import urllib.request

RACINE = r"c:\Users\Utilisateur\Desktop\FabWare\MeshyMyself"
W = "https://myfabmesh-cloud.fabien65400.workers.dev"
FX = 1.10          # 1 EUR = 1,10 USD (hypothese explicite)

# Packs : (nom, euros, credits). Le pire ratio fait foi.
PACKS = [('Starter', 5, 25), ('Pro', 20, 120), ('Studio', 50, 350),
         ('Abo Starter', 5, 30), ('Abo Pro', 15, 100), ('Abo Studio', 40, 300)]
CR_EUR = min(e / c for _, e, c in PACKS)

# Couts REELS, mesures sur la facture Modal. Source et date obligatoires.
MESURES = {
    'mesh_fast':      (0.7074, '2026-08-04, generation a froid, creneau isole'),
    'mesh_balanced':  (0.7074, '2026-08-04, idem (meme travail GPU mesure)'),
    'mesh_quality':   (0.7074, '2026-08-04, idem — NON mesure separement'),
    'mesh_ultra_8k':  (0.7074, '2026-08-04, idem — NON mesure separement'),
    'text2image':     (0.1944, '2026-08-04, image a froid, creneau isole'),
    'segment':        (0.1107, '2026-08-04, segmentation reelle, 117 s'),
}
# Couts SUPPOSES : jamais confrontes a la facture.
SUPPOSES = {
    'back_view': 0.004, 'modify': 0.004, 'face_fix_image': 0.004,
    'upscale': 0.004, 'rectify': 0.003, 'auto_inpaint': 0.008,
    'mask_inpaint': 0.008, 'remove_background': 0.02, 'mesh_op_simple': 0.001,
}

prix = json.loads(urllib.request.urlopen(
    urllib.request.Request(W + '/api/pricing',
                           headers={'User-Agent': 'audit'}), timeout=60)
    .read().decode())['prices']

print('=' * 78)
print('VALEUR DU CREDIT — le pack le plus defavorable fait foi')
print('=' * 78)
for n, e, c in PACKS:
    marque = '  <-- CONTRAINTE' if abs(e / c - CR_EUR) < 1e-9 else ''
    print(f'  {n:14} {e:2} EUR / {c:3} cr = {e/c:.4f} EUR/credit{marque}')

print()
print('=' * 78)
print('MARGES SUR COUT MESURE  (le seul tableau sur lequel on peut s appuyer)')
print('=' * 78)
print(f'  {"operation":18} {"prix":>6} {"encaisse":>9} {"cout reel":>10} {"marge":>9}  {"%":>5}')
neg = []
for k, (cout, src) in sorted(MESURES.items()):
    cr = prix.get(k)
    if cr is None:
        print(f'  {k:18} ABSENT DE LA GRILLE')
        continue
    rev = cr * CR_EUR
    ce = cout / FX
    m = rev - ce
    pct = (m / rev * 100) if rev else 0
    if m <= 0:
        neg.append(k)
    print(f'  {k:18} {cr:4} cr {rev:8.3f}E {ce:9.3f}E {m:+8.3f}E {pct:5.0f}%')

print()
print('  Sources :')
for k, (_, src) in sorted(MESURES.items()):
    print(f'    {k:18} {src}')

print()
print('=' * 78)
print('MARGES SUR COUT SUPPOSE  —  A NE PAS PRENDRE POUR ARGENT COMPTANT')
print('=' * 78)
print(f'  {"operation":18} {"prix":>6} {"encaisse":>9} {"cout suppose":>13} {"marge":>9}')
for k, cout in sorted(SUPPOSES.items()):
    cr = prix.get(k)
    if cr is None:
        continue
    rev = cr * CR_EUR
    ce = cout / FX
    m = rev - ce
    if m <= 0:
        neg.append(k)
    print(f'  {k:18} {cr:4} cr {rev:8.3f}E {ce:12.3f}E {m:+8.3f}E')

print()
print('=' * 78)
print('OPERATIONS TARIFEES DONT LE COUT N EST NI MESURE NI ESTIME')
print('=' * 78)
connues = set(MESURES) | set(SUPPOSES)
orphelines = [k for k in sorted(prix) if k not in connues]
for k in orphelines:
    print(f'  {k:22} {prix[k]:3} cr = {prix[k]*CR_EUR:.3f} EUR encaisses, cout INCONNU')
if not orphelines:
    print('  (aucune)')

print()
print('=' * 78)
print('VERDICT')
print('=' * 78)
print(f'  operations a marge NEGATIVE : {len(neg)}' + (' -> ' + ', '.join(neg) if neg else ''))
print(f'  operations tarifees au total : {len(prix)}')
print(f'  dont cout REELLEMENT MESURE  : {len([k for k in MESURES if k in prix])}')
print(f'  dont cout suppose            : {len([k for k in SUPPOSES if k in prix])}')
print(f'  dont cout INCONNU            : {len(orphelines)}')
