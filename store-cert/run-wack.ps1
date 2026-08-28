# WACK sur le dernier paquet Store construit.
#
# A LANCER EN ADMINISTRATEUR : appcert.exe exige l'elevation, et c'est la
# seule etape de la chaine qui ne peut pas etre automatisee sans ton clic UAC.
#
# Clic droit sur ce fichier > "Executer avec PowerShell" ne suffit PAS.
# Ouvre un PowerShell ADMIN, puis :
#   cd C:\Users\Utilisateur\Desktop\FabWare\MeshyMyself
#   powershell -ExecutionPolicy Bypass -File store-cert\run-wack.ps1
#
# POURQUOI C'EST OBLIGATOIRE
# Les six refus de certification precedents n'avaient JAMAIS eu de passage
# WACK. Et un rapport PASS ne vaut que pour LE binaire teste : le 28/08 un
# WACK_1.0.33_PASS.xml du 20/08 trainait a cote d'un paquet 1.0.33
# reconstruit le soir meme, avec des semaines de changements entre les deux.
# Un rapport plus vieux que le paquet ne certifie rien.
#
# A SAVOIR : pour un paquet Centennial, WACK annonce "Running tests without
# application deployment" -- il fait de l'analyse statique et NE TESTE PAS le
# lancement. Il valide le manifeste, pas le fait que l'appli demarre.

$ErrorActionPreference = 'Stop'

$appcert = 'C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe'
if (-not (Test-Path $appcert)) {
  Write-Host "appcert.exe introuvable. Installe le Windows SDK (App Certification Kit)." -ForegroundColor Red
  exit 1
}

# Verification d'elevation : sans elle, appcert echoue par une exception
# PowerShell peu lisible plutot que par un message clair.
$estAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $estAdmin) {
  Write-Host "Ce script doit tourner dans un PowerShell ADMINISTRATEUR." -ForegroundColor Red
  Write-Host "  (appcert.exe : 'The requested operation requires elevation')"
  exit 1
}

$racine = Split-Path -Parent $PSScriptRoot
$dossier = Join-Path $racine 'dist\installer\MicrosoftStore'

$paquet = Get-ChildItem -Path $dossier -Filter '*.appx' |
          Sort-Object LastWriteTime -Descending |
          Select-Object -First 1
if (-not $paquet) {
  Write-Host "Aucun .appx dans $dossier. Lance d'abord : npm run build:msix" -ForegroundColor Red
  exit 1
}

$horodatage = Get-Date -Format 'yyyyMMdd-HHmm'
$rapport = Join-Path $dossier ("WACK_" + $paquet.BaseName.Split(' ')[-1] + "_$horodatage.xml")

Write-Host "Paquet  : $($paquet.Name)"
Write-Host "Construit : $($paquet.LastWriteTime)"
Write-Host "Rapport : $rapport"
Write-Host ""
Write-Host "Compte 10 a 25 minutes. Ne ferme pas la fenetre." -ForegroundColor Yellow
Write-Host ""

& $appcert reset | Out-Null
& $appcert test -appxpackagepath $paquet.FullName -reportoutputpath $rapport

if (-not (Test-Path $rapport)) {
  Write-Host "Aucun rapport produit : WACK n'est pas alle au bout." -ForegroundColor Red
  exit 1
}

$resultat = ([xml](Get-Content $rapport)).REPORT.OVERALL_RESULT
Write-Host ""
if ($resultat -eq 'PASS') {
  Write-Host "OVERALL_RESULT = PASS" -ForegroundColor Green
  $final = Join-Path $dossier ("WACK_" + $paquet.BaseName.Split(' ')[-1] + "_PASS_$horodatage.xml")
  Move-Item $rapport $final -Force
  Write-Host "Rapport : $final"
  Write-Host ""
  Write-Host "Rappel : WACK valide le manifeste, PAS le demarrage de l'appli."
  Write-Host "Passe aussi le banc de test MSIX avant de soumettre."
} else {
  Write-Host "OVERALL_RESULT = $resultat" -ForegroundColor Red
  Write-Host "Ouvre le rapport et regarde quels tests ont echoue :"
  Write-Host "  $rapport"
  exit 1
}
