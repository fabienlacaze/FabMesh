#!/usr/bin/env python
"""Translate a user prompt to English with Argos Translate (offline, MIT, CPU).

FabMesh's image models (RealVisXL / HiDream) need English prompts, but the UI
supports 6 languages (en/zh/hi/es/fr/ar). This helper translates the user's
raw text from their interface language to English BEFORE the English asset-type
templates are concatenated.

Usage:
    translate_prompt.py --text "fourmi géante" --from fr   -> "giant ant"
    translate_prompt.py --text "..."           --from en   -> passthrough

Fails OPEN: if Argos or the language package isn't available, it prints the
input unchanged (so generation never breaks because of translation).
"""
import argparse
import sys

# Windows console is cp1252; Arabic/Hindi/Chinese output needs UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def translate_to_english(text, src):
    src = (src or "en").lower()
    if src == "en" or not text.strip():
        return text
    try:
        from argostranslate import translate as _t
        # Modern convenience API.
        try:
            out = _t.translate(text, src, "en")
            if out:
                return out
        except Exception:
            pass
        # Fallback to the language-objects API (older Argos).
        langs = _t.get_installed_languages()
        from_lang = next((l for l in langs if l.code == src), None)
        to_lang = next((l for l in langs if l.code == "en"), None)
        if from_lang and to_lang:
            return from_lang.get_translation(to_lang).translate(text) or text
    except Exception as e:
        sys.stderr.write(f"[translate] fallback (no translation for '{src}'): {e}\n")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--from", dest="src", default="en")
    args = ap.parse_args()
    sys.stdout.write(translate_to_english(args.text, args.src))


if __name__ == "__main__":
    main()
