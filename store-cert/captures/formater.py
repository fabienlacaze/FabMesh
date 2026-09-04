"""Met les captures d'ecran au format du Microsoft Store.

    python store-cert/captures/formater.py            # traite brut/ -> store/
    python store-cert/captures/formater.py --check    # ne fait que verifier

Regles du Store : PNG, entre 1366x768 et 3840x2160, 16:9 recommande.

CE QUE FAIT LE SCRIPT, ET POURQUOI
- Il ne ROGNE JAMAIS : rogner une capture d'interface coupe des boutons ou
  des cartes sur les bords. Il complete les marges pour atteindre 16:9 avec
  la couleur de fond de l'application, echantillonnee sur les bords de
  l'image -- invisible a l'oeil, puisque c'est la meme couleur.
- Il n'AGRANDIT jamais : agrandir floute. La sortie garde la taille native,
  marges comprises (2560x1369 -> 2560x1440, 1294x860 -> 1529x860). Il ne
  reechantillonne que si la capture depasse 3840x2160. Si meme avec ses
  marges elle reste sous 1366x768, il refuse : la capture est a reprendre.
- Il numerote dans l'ordre des noms de fichiers : nomme tes captures
  01_..., 02_... pour fixer l'ordre, sinon c'est l'ordre alphabetique.
"""
import sys
from pathlib import Path
from PIL import Image

ICI = Path(__file__).parent
BRUT, STORE = ICI / "brut", ICI / "store"
MIN_L, MIN_H = 1366, 768
MAX_L, MAX_H = 3840, 2160
RATIO = 16 / 9


def couleur_de_fond(im: Image.Image) -> tuple:
    """Couleur la plus frequente sur les 4 bords : c'est le fond de l'app."""
    px = im.convert("RGB").load()
    l, h = im.size
    echantillons = []
    for x in range(0, l, max(1, l // 200)):
        echantillons += [px[x, 0], px[x, h - 1]]
    for y in range(0, h, max(1, h // 200)):
        echantillons += [px[0, y], px[l - 1, y]]
    return max(set(echantillons), key=echantillons.count)


def formater(src: Path, dst: Path, verifier_seulement: bool) -> str:
    im = Image.open(src)
    l, h = im.size

    # Taille 16:9 NATIVE : on ajoute des marges, jamais de pixels inventes.
    # Une capture de 1294x860 devient 1529x860 -- au-dessus du minimum du
    # Store sans avoir ete agrandie d'un seul pixel. C'est pour ca qu'on
    # regarde la taille APRES marges, pas avant.
    if l / h >= RATIO:
        natif = (l, round(l / RATIO))
    else:
        natif = (round(h * RATIO), h)
    if natif[0] < MIN_L or natif[1] < MIN_H:
        return (f"REFUSE  {src.name} : {l}x{h} -> {natif[0]}x{natif[1]} apres marges, "
                f"encore sous le minimum {MIN_L}x{MIN_H} -- a reprendre plus grande")
    # Seul cas de reechantillonnage : une capture plus grande que le maximum.
    cible = natif if natif[0] <= MAX_L and natif[1] <= MAX_H else (MAX_L, MAX_H)

    # Reduction homothetique pour tenir dans la cible, puis marges de fond.
    echelle = min(cible[0] / l, cible[1] / h, 1.0)
    nl, nh = round(l * echelle), round(h * echelle)
    fond = couleur_de_fond(im)
    verdict = (f"{src.name}: {l}x{h} -> {cible[0]}x{cible[1]} "
               f"(contenu {nl}x{nh}, marges {cible[0]-nl}x{cible[1]-nh}, fond {fond})")
    if verifier_seulement:
        return "OK      " + verdict

    reduit = im.convert("RGB").resize((nl, nh), Image.LANCZOS) if echelle < 1 else im.convert("RGB")
    toile = Image.new("RGB", cible, fond)
    toile.paste(reduit, ((cible[0] - nl) // 2, (cible[1] - nh) // 2))
    toile.save(dst, "PNG", optimize=True)
    return "ECRIT   " + verdict


def main() -> int:
    verifier = "--check" in sys.argv
    sources = sorted(p for p in BRUT.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
    if not sources:
        print(f"aucune capture dans {BRUT}")
        return 1
    STORE.mkdir(exist_ok=True)
    refus = 0
    for i, src in enumerate(sources, 1):
        dst = STORE / f"{i:02d}_{src.stem}.png"
        ligne = formater(src, dst, verifier)
        print("  " + ligne)
        refus += ligne.startswith("REFUSE")
    print(f"\n{len(sources) - refus} capture(s) au format Store" + ("" if verifier else f" dans {STORE}"))
    return 1 if refus else 0


if __name__ == "__main__":
    sys.exit(main())
