"""Regenere les tables de prompts de Modal DEPUIS celles du desktop.

POURQUOI CE SCRIPT EXISTE
=========================
Le prompt final est construit DEUX FOIS : une fois par le client
(src/renderer/index2.js) et une fois par Modal (modal_app/_prompts.py).
Le worker jette le prompt enrichi du client et laisse Modal refaire le
travail depuis ses propres tables. Deux copies a maintenir a la main,
donc deux copies qui divergent.

Elles avaient diverge sans que personne ne le voie (audit du 2026-08-02) :
  - STYLES : 8 entrees cote Modal contre 33 dans l'interface. Cyberpunk,
    Ghibli, Pixar, Aquarelle, Chrome, Marbre... ne produisaient RIEN,
    pour 2 credits debites a chaque image.
  - TYPES  : 10 contre 17. Manquaient avion, bateau, insect et les quatre
    « other_* », avec leurs garde-fous anatomiques (« exactly six legs,
    NOT a spider », « NEVER bipedal »).
  - Trois cles divergeaient meme d'ORTHOGRAPHE, et la cle Modal
    'concept-art' contenait le texte du style desktop 'painterly' : un
    simple renommage aurait envoye deux styles sur la mauvaise
    description.

Le desktop fait autorite (c'est lui que voit l'utilisateur dans les
menus). Modal garde le controle du prompt final, mais sa table est
GENEREE, plus jamais recopiee.

USAGE
=====
    python build/sync_prompt_tables.py            # regenere
    python build/sync_prompt_tables.py --verify   # echoue si divergence

Le mode --verify est branche en garde-fou de build, comme
build/patch_ovoxel_wheel.py pour la licence nvdiffrast.
"""
import io
import os
import re
import sys

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_JS = os.path.join(RACINE, 'src', 'renderer', 'index2.js')
DST_PY = os.path.join(RACINE, 'modal_app', '_prompts.py')

# Alias : orthographes historiquement utilisees cote cloud, conservees
# pour qu'un client en cache continue de fonctionner. La valeur est celle
# de la cle desktop correspondante.
ALIAS = {
    'low-poly':    'lowpoly',
    'pixel-art':   'pixelart',
    'concept-art': 'painterly',
}


def extraire(nom_table: str) -> list[tuple[str, str]]:
    """Recupere les paires (cle, valeur) d'un objet JS du renderer."""
    src = io.open(SRC_JS, encoding='utf-8').read()
    debut = src.index(f'const {nom_table} = {{')
    fin = src.index('\n};', debut)
    bloc = src[debut:fin]
    # cle: 'valeur'  — cle quotee ou non. Les lignes de commentaire du
    # desktop ne matchent pas (elles n'ont pas la forme cle: 'valeur').
    paires = re.findall(r"^\s*'?([A-Za-z0-9_-]+)'?\s*:\s*'([^']*)'", bloc, re.M)
    if len(paires) < 10:
        raise SystemExit(
            f'{nom_table}: {len(paires)} entrees extraites, c\'est trop peu — '
            'le format du source desktop a probablement change. '
            'NE PAS ecrire une table tronquee.')
    return paires


def rendre(nom: str, paires: list[tuple[str, str]], avec_alias: bool) -> str:
    d = dict(paires)
    lignes = [f'{nom} = {{',
              '    # GENERE PAR build/sync_prompt_tables.py — NE PAS EDITER A LA MAIN.',
              '    # Source de verite : src/renderer/index2.js (ce que voit',
              "    # l'utilisateur dans les menus). Toute modification faite ici",
              '    # sera ecrasee, et `--verify` fera echouer le build.']
    for k, v in paires:
        lignes.append('    %-20s: %s,' % (repr(k), repr(v)))
    if avec_alias:
        lignes.append('    # Alias de compatibilite : orthographes utilisees')
        lignes.append("    # historiquement cote cloud, gardees pour les clients en cache.")
        for vieux, neuf in ALIAS.items():
            lignes.append('    %-20s: %s,' % (repr(vieux), repr(d.get(neuf, ''))))
        lignes.append("    %-20s: ''," % repr('none'))
    lignes.append('}')
    return '\n'.join(lignes)


def remplacer(contenu: str, nom: str, nouveau: str) -> str:
    a = contenu.index(f'{nom} = {{')
    b = contenu.index('\n}', a) + 2
    return contenu[:a] + nouveau + contenu[b:]


def main() -> int:
    verifier = '--verify' in sys.argv

    types = extraire('ASSET_TYPE_PROMPTS')
    styles = extraire('ASSET_STYLE_PROMPTS')

    actuel = io.open(DST_PY, encoding='utf-8').read()
    attendu = remplacer(actuel, 'ASSET_TYPE_PROMPTS',
                        rendre('ASSET_TYPE_PROMPTS', types, avec_alias=False))
    attendu = remplacer(attendu, 'ASSET_STYLE_PROMPTS',
                        rendre('ASSET_STYLE_PROMPTS', styles, avec_alias=True))

    if attendu == actuel:
        print(f'[sync_prompt_tables] a jour — {len(types)} types, '
              f'{len(styles)} styles (+{len(ALIAS)} alias)')
        return 0

    if verifier:
        print('[sync_prompt_tables] ECHEC : modal_app/_prompts.py a DIVERGE '
              'de src/renderer/index2.js.', file=sys.stderr)
        print('  Des styles ou des types de l\'interface seraient SILENCIEUSEMENT '
              'sans effet cote cloud, et factures.', file=sys.stderr)
        print('  Corriger avec : python build/sync_prompt_tables.py', file=sys.stderr)
        return 1

    io.open(DST_PY, 'w', encoding='utf-8').write(attendu)
    print(f'[sync_prompt_tables] regenere — {len(types)} types, '
          f'{len(styles)} styles (+{len(ALIAS)} alias)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
