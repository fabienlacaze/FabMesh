#!/usr/bin/env python3
"""Restore FabMesh secrets from the encrypted `secrets.sealed` blob.

On a fresh machine after `git clone`:

  python scripts/secrets_unseal.py            # restore (asks before overwrite)
  python scripts/secrets_unseal.py --force    # overwrite without asking

Reads the passphrase interactively (or FABMESH_SECRETS_PASSPHRASE for CI).
A wrong passphrase fails loudly (AES-GCM auth tag) — it never writes garbage.
"""
import os
import sys
import json
import base64
import getpass


SEALED_PATH = 'secrets.sealed'
FORMAT = 'fabmesh-secrets-sealed-v1'


def _ub64(s):
    return base64.b64decode(s.encode('ascii'))


def main():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    from cryptography.exceptions import InvalidTag

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(root)
    force = '--force' in sys.argv

    if not os.path.isfile(SEALED_PATH):
        print(f'ERROR: {SEALED_PATH} not found (nothing to restore).', file=sys.stderr)
        sys.exit(1)
    with open(SEALED_PATH, encoding='utf-8') as fh:
        blob = json.load(fh)
    if blob.get('_format') != FORMAT:
        print(f'ERROR: unexpected format {blob.get("_format")!r}.', file=sys.stderr)
        sys.exit(1)

    passphrase = os.environ.get('FABMESH_SECRETS_PASSPHRASE') or \
        getpass.getpass('Passphrase: ')
    key = Scrypt(salt=_ub64(blob['salt']), length=32,
                 n=blob['n'], r=blob['r'], p=blob['p']).derive(
        passphrase.encode('utf-8'))
    try:
        plaintext = AESGCM(key).decrypt(
            _ub64(blob['nonce']), _ub64(blob['ciphertext']), FORMAT.encode('ascii'))
    except InvalidTag:
        print('ERROR: wrong passphrase (or corrupted blob).', file=sys.stderr)
        sys.exit(2)

    files = json.loads(plaintext)['files']
    restored = 0
    for name, b64 in files.items():
        if os.path.exists(name) and not force:
            ans = input(f'{name} already exists — overwrite? [y/N] ').strip().lower()
            if ans != 'y':
                print(f'  skipped {name}')
                continue
        os.makedirs(os.path.dirname(os.path.abspath(name)), exist_ok=True)
        with open(name, 'wb') as fh:
            fh.write(_ub64(b64))
        print(f'  restored {name} ({os.path.getsize(name)} bytes)')
        restored += 1
    print(f'\nDone — {restored}/{len(files)} secret file(s) restored.')


if __name__ == '__main__':
    main()
