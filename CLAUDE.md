# FabMesh — Claude Code instructions

## Auto-commit
Après chaque modification testable (feature finie, fix validé, refactor
qui compile), créer immédiatement un commit avec message clair, sans
demander confirmation.

PUSH SYSTÉMATIQUE après chaque commit (`git push` immédiat, sans
demander). Règle changée le 2026-07-20 à la demande du user — l'ancienne
règle « ne pas push » est abandonnée.

Ne pas attendre que plusieurs changements s'accumulent : un commit par
unité logique de travail (1 fix = 1 commit, 1 feature = 1 commit).

## Auto-update AGENT_LOG.md
Avant tout `git commit` qui touche aux scripts ou au pipeline, ajouter
une entrée datée à `AGENT_LOG.md` à la racine du projet décrivant ce
qui change et pourquoi. Un hook Bash bloque les commits si AGENT_LOG.md
n'a pas été modifié dans la dernière heure.

## Restart Electron quand main.js change
Modifier `src/main/main.js` ou `src/main/preload.js` impose un restart
complet d'Electron (Ctrl+R reload uniquement le renderer). Pour
relancer:
```bash
powershell -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
unset ELECTRON_RUN_AS_NODE
node_modules/.bin/electron . > logs/fabmesh_start.log 2>&1 &
```
Modifier uniquement `src/renderer/*` ou `scripts/*.py` = pas de restart
Electron, juste Ctrl+R dans la fenêtre (ou re-déclencher l'action).

## Renderer logs
`console.log` du renderer va dans `logs/renderer.log` (via le handler
IPC `renderer-log`). `logs/fabmesh_start.log` ne contient que les logs
du process main + stdout des subprocess Python.

## Backups avant modifs lourdes
Avant un changement structurel (refactor architecture, switch de modèle,
modification d'un script Python sensible), et quand le user demande un
« backup », créer une branche backup ET LA PUSHER sur GitHub (un backup
non pushé ne sert à rien — exigence user):
```bash
git checkout -b backup-<short-desc>-$(date +%Y%m%d-%H%M%S)
git push -u origin HEAD
git checkout <branche-de-travail>
```

## Deploy cloud — TOUJOURS rebuild avant wrangler deploy
Le worker Cloudflare est servi depuis `cloud/wrangler.toml > [assets]
directory = "out"`. Modifier `cloud/public/app/*.js` ne SUFFIT PAS —
il faut `cd cloud && npm run build` pour que les changements soient
copiés dans `out/`, ENSUITE `npx wrangler deploy`.

Sinon `wrangler deploy` upload bien le worker (src/worker.ts) mais
l'ancien `out/` est re-publié et les changements UI ne sortent pas.
Symptôme: `curl https://…/app/index2.js | wc -c` montre une taille
< que le fichier source.

Pattern: `cd cloud && npm run build && npx wrangler deploy`.

## Commits sûrs / risqués
- **Sûr (commit auto OK)**: fix bug ciblé, ajout d'un slider/bouton,
  ajustement de paramètres (ip_scale, prompt, etc.), update doc.
- **Demander confirmation**: refactor large, suppression de fichiers,
  changement de licence ou dépendance lourde, destruction de branches.
  (Le push n'est PLUS soumis à confirmation — voir Auto-commit.)
