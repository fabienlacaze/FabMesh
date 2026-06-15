#!/usr/bin/env python3
"""Seal FabMesh secrets into an encrypted, GitHub-safe blob.

Bundles the local secret files (.env, tokens, config.json) into ONE
AES-256-GCM blob (`secrets.sealed`) that is SAFE to commit to GitHub — only
someone with your passphrase can decrypt it.

  python scripts/secrets_seal.py                 # seal the default files
  python scripts/secrets_seal.py .env extra.json # seal a custom list

The passphrase is read interactively (never on the command line, never
logged). For non-interactive use set FABMESH_SECRETS_PASSPHRASE (CI only).

Crypto: scrypt(n=2^16,r=8,p=1) key-derivation from your passphrase + a random
16-byte salt, then AES-256-GCM with a random 12-byte nonce (authenticated —
a wrong passphrase fails loudly instead of producing garbage).

After sealing:  git add secrets.sealed && git commit && git push
Restore with:   python scripts/secrets_unseal.py
"""
import os
import sys
import json
import base64
import getpass

# Default secret files (relative to repo root = parent of scripts/).
DEFAULT_FILES = ['.env', '.mcp_bridge_token', '.test_api_token', 'config.json']
SEALED_PATH = 'secrets.sealed'
FORMAT = 'fabmesh-secrets-sealed-v1'
SCRYPT_N, SCRYPT_R, SCRYPT_P = 1 << 16, 8, 1


def _b64(b):
    return base64.b64encode(b).decode('ascii')


def _derive(passphrase: str, salt: bytes) -> bytes:
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    return Scrypt(salt=salt, length=32, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P).derive(
        passphrase.encode('utf-8'))


def _get_passphrase() -> str:
    env = os.environ.get('FABMESH_SECRETS_PASSPHRASE')
    if env:
        return env
    p1 = getpass.getpass('Passphrase (you must remember this — keep it in your '
                         'password manager): ')
    if len(p1) < 8:
        print('ERROR: use at least 8 characters.', file=sys.stderr)
        sys.exit(1)
    p2 = getpass.getpass('Confirm passphrase: ')
    if p1 != p2:
        print('ERROR: passphrases do not match.', file=sys.stderr)
        sys.exit(1)
    return p1


def main():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    files = sys.argv[1:] or DEFAULT_FILES

    bundle = {}
    for f in files:
        if os.path.isfile(f):
            with open(f, 'rb') as fh:
                bundle[f] = _b64(fh.read())
            print(f'  + {f} ({os.path.getsize(f)} bytes)')
        else:
            print(f'  - {f} (not found, skipped)')
    if not bundle:
        print('ERROR: no secret files found to seal.', file=sys.stderr)
        sys.exit(1)

    passphrase = _get_passphrase()
    plaintext = json.dumps({'files': bundle}).encode('utf-8')
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = _derive(passphrase, salt)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, FORMAT.encode('ascii'))

    out = {
        '_format': FORMAT, 'kdf': 'scrypt',
        'n': SCRYPT_N, 'r': SCRYPT_R, 'p': SCRYPT_P,
        'salt': _b64(salt), 'nonce': _b64(nonce), 'ciphertext': _b64(ciphertext),
    }
    with open(SEALED_PATH, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, indent=2)
    print(f'\nSealed {len(bundle)} file(s) -> {SEALED_PATH} '
          f'({os.path.getsize(SEALED_PATH)} bytes).')
    print('Now: git add secrets.sealed && git commit -m "chore: update sealed secrets" && git push')


if __name__ == '__main__':
    main()
