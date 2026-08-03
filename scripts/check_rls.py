"""Test de non-regression des politiques RLS Supabase.

Verifie qu'avec la cle ANON — celle qui est PUBLIQUE, presente dans le
bundle servi a chaque visiteur — personne ne peut lire les donnees des
autres comptes ni s'auto-crediter.

A rejouer apres toute migration SQL ou tout changement de politique.

    python scripts/check_rls.py        # code de sortie 1 si une faille

PIEGE A CONNAITRE : une requete d'ecriture PostgREST avec
`Prefer: return=minimal` renvoie 204 meme quand RLS a bloque et que ZERO
ligne a ete modifiee. Un test naif conclut donc a une faille inexistante.
On demande ici `return=representation` et on COMPTE les lignes reellement
touchees, en recoupant avec une lecture faite a la cle service.
"""
import io
import json
import os
import sys
import urllib.error
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(RACINE, 'cloud', '.env.local')

conf = {}
for ligne in io.open(ENV, encoding='utf-8'):
    ligne = ligne.strip()
    if not ligne or ligne.startswith('#') or '=' not in ligne:
        continue
    k, v = ligne.split('=', 1)
    conf[k.strip()] = v.strip().strip('"').strip("'")

URL = conf.get('NEXT_PUBLIC_SUPABASE_URL', '').rstrip('/')
ANON = conf.get('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
SVC = conf.get('SUPABASE_SERVICE_ROLE_KEY') or conf.get('SUPABASE_SERVICE_ROLE', '')
if not (URL and ANON and SVC):
    raise SystemExit('cloud/.env.local incomplet (URL / ANON / SERVICE_ROLE)')

echecs = []


def lire(cle, chemin):
    r = urllib.request.Request(URL + chemin,
                               headers={'apikey': cle, 'Authorization': 'Bearer ' + cle})
    return json.load(urllib.request.urlopen(r, timeout=20))


print('=== LECTURE avec la cle publique (doit tout bloquer) ===')
for table in ('profiles', 'jobs', 'payments', 'user_assets'):
    try:
        lignes = lire(ANON, f'/rest/v1/{table}?select=*&limit=3')
        fuite = len(lignes) > 0
        print(f'  {table:14} {len(lignes)} ligne(s)' + ('   <-- FUITE' if fuite else '   ok'))
        if fuite:
            echecs.append(f'{table} lisible avec la cle publique')
    except urllib.error.HTTPError as e:
        print(f'  {table:14} HTTP {e.code}   ok (refuse)')

print()
print('=== ECRITURE avec la cle publique (doit ne rien modifier) ===')
avant = lire(SVC, '/rest/v1/profiles?select=id,credits&order=id&limit=5')
try:
    r = urllib.request.Request(
        URL + '/rest/v1/profiles?id=neq.00000000-0000-0000-0000-000000000000',
        headers={'apikey': ANON, 'Authorization': 'Bearer ' + ANON,
                 'Content-Type': 'application/json',
                 'Prefer': 'return=representation'},
        method='PATCH', data=json.dumps({'credits': 99999}).encode())
    touchees = json.load(urllib.request.urlopen(r, timeout=20))
    print(f'  auto-credit : {len(touchees)} ligne(s) modifiee(s)'
          + ('   <-- FAILLE' if touchees else '   ok'))
    if touchees:
        echecs.append('UPDATE profiles accepte avec la cle publique')
except urllib.error.HTTPError as e:
    print(f'  auto-credit : HTTP {e.code}   ok (refuse)')

for label, chemin, corps in (
    ('RPC add_credits  ', '/rest/v1/rpc/add_credits',
     {'p_user_id': '00000000-0000-0000-0000-000000000001', 'p_amount': 9999}),
    ('RPC spend_credits', '/rest/v1/rpc/spend_credits',
     {'p_user_id': '00000000-0000-0000-0000-000000000001', 'p_amount': 1}),
    ('INSERT payments  ', '/rest/v1/payments',
     {'stripe_session_id': '_rls_test', 'user_id': '00000000-0000-0000-0000-000000000001',
      'pack_id': 'studio', 'credits': 350}),
):
    try:
        r = urllib.request.Request(
            URL + chemin,
            headers={'apikey': ANON, 'Authorization': 'Bearer ' + ANON,
                     'Content-Type': 'application/json'},
            method='POST', data=json.dumps(corps).encode())
        urllib.request.urlopen(r, timeout=20)
        print(f'  {label} : ACCEPTE   <-- FAILLE')
        echecs.append(f'{label.strip()} accessible avec la cle publique')
    except urllib.error.HTTPError as e:
        print(f'  {label} : HTTP {e.code}   ok (refuse)')

apres = lire(SVC, '/rest/v1/profiles?select=id,credits&order=id&limit=5')
if avant != apres:
    print()
    print('  !! LES SOLDES ONT CHANGE PENDANT LE TEST')
    echecs.append('soldes modifies par un appel anonyme')

print()
if echecs:
    print('ECHEC — ' + str(len(echecs)) + ' probleme(s) :')
    for e in echecs:
        print('   - ' + e)
    sys.exit(1)
print('OK — la cle publique ne peut ni lire ni ecrire les donnees des comptes.')
