# Lance Claude Code en mode Remote Control, pilotable depuis claude.ai/code
# (web) ou l'app mobile, sans VS Code. Execute par la tache planifiee
# « Claude Remote Control » a l'ouverture de session (voir
# configurer-wake-on-lan.ps1 pour la partie reveil du PC).
#
# Manuel :  powershell -ExecutionPolicy Bypass -File outils\lancer-claude-remote-control.ps1
#
# Le processus DOIT rester vivant : s'il s'arrete, la session passe hors
# ligne sur claude.ai. Journal : logs\claude-remote-control.log
$repo = 'C:\Users\Utilisateur\Desktop\FabWare\MeshyMyself'
$claude = 'C:\Users\Utilisateur\AppData\Roaming\npm\claude.cmd'   # chemin absolu : une tache planifiee n'a pas le PATH de l'utilisateur
$log = Join-Path $repo 'logs\claude-remote-control.log'

Set-Location $repo
$env:ELECTRON_RUN_AS_NODE = $null
"[$(Get-Date -Format s)] demarrage remote-control" | Out-File -Append -Encoding utf8 $log

# Boucle de relance : si claude sort (mise a jour, erreur reseau), on repart
# apres 30 s au lieu de laisser la machine allumee sans session.
while ($true) {
  & $claude remote-control --name 'PC Fabien (MeshyMyself)' 2>&1 | Out-File -Append -Encoding utf8 $log
  "[$(Get-Date -Format s)] remote-control termine (code $LASTEXITCODE), relance dans 30 s" | Out-File -Append -Encoding utf8 $log
  Start-Sleep -Seconds 30
}
