"""Met les captures d'ecran au format du Microsoft Store.

    python store-cert/captures/formater.py            # traite brut/ -> store/
    python store-cert/captures/formater.py --check    # ne fait que verifier

Regles du Store : PNG, entre 1366x768 et 3840x2160, 16:9 recommande.

CE QUE FAIT LE SCRIPT, ET POURQUOI
- Il ne ROGNE JAMAIS : rogner une capture d'interface coupe des boutons ou
  des cartes sur les bords. Il complete les marges pour atteindre 16:9 avec
  la couleur de fond de l'application, echantillonnee sur les bords de
  l'image -- invisible a l'oeil, puisque c'est la meme couleur.
- Il n'AGRANDIT jamais : agrandir floute. Une capture de 2560 de large sort
  en 2560x1440 ; une capture plus petite sort en 1920x1080 ; en dessous de
  1366x768 il refuse, la capture est a reprendre.
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
    if l < MIN_L or h < MIN_H:
        return f"REFUSE  {src.name} : {l}x{h}, en dessous du minimum {MIN_L}x{MIN_H} -- a reprendre"

    # Cible : la plus grande taille 16:9 qui n'agrandit pas la capture.
    cible = (2560, 1440) if l >= 2560 and h >= 1300 else (1920, 1080)
    if l > MAX_L or h > MAX_H:
        cible = (MAX_L, MAX_H)

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
