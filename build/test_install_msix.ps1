# =============================================================================
# test_install_msix.ps1 — installe le package MSIX EN LOCAL pour le tester
# -----------------------------------------------------------------------------
# Le .appx destine au Store n'est PAS signe (Microsoft signe a la publication),
# donc Windows refuse de l'installer tel quel. Ce script suit la procedure
# officielle de sideload :
#   1. cree un certificat de TEST dont le sujet = le Publisher du manifeste
#   2. l'ajoute aux "Personnes de confiance" de la machine
#   3. signe le .appx avec ce certificat
#   4. installe le package
#
# NE DESACTIVE RIEN (ni Smart App Control, ni SmartScreen, ni Defender).
# Le certificat de test ne sert qu'a valider l'installation en local ; le
# package publie sur le Store sera signe par Microsoft.
#
# USAGE (clic droit sur PowerShell > "Executer en tant qu'administrateur") :
#   cd c:\Users\Utilisateur\Desktop\FabWare\MeshyMyself
#   powershell -ExecutionPolicy Bypass -File build\test_install_msix.ps1
#
# Pour tout retirer ensuite :
#   powershell -ExecutionPolicy Bypass -File build\test_install_msix.ps1 -Cleanup
# =============================================================================
param([switch]$Cleanup)

$ErrorActionPreference = 'Stop'
$Publisher = 'CN=3767FC33-F877-4481-9639-BC9CFF9D1371'   # = build.appx.publisher
$PkgName   = 'AyrosStudio.MyFabmesh.AI'
$FriendlyName = 'MyFabmesh Local Test Certificate'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Ce script doit etre lance en ADMINISTRATEUR." -ForegroundColor Red
    Write-Host "  -> clic droit sur PowerShell > Executer en tant qu'administrateur" -ForegroundColor Yellow
    exit 1
  }
}

if ($Cleanup) {
  Write-Host "== Nettoyage ==" -ForegroundColor Cyan
  Assert-Admin
  Get-AppxPackage -Name "*MyFabmesh*" | ForEach-Object {
    Write-Host "  desinstallation de $($_.Name) $($_.Version)"
    Remove-AppxPackage $_.PackageFullName -ErrorAction SilentlyContinue
  }
  foreach ($store in @('Cert:\LocalMachine\TrustedPeople', 'Cert:\CurrentUser\My')) {
    Get-ChildItem $store -ErrorAction SilentlyContinue |
      Where-Object { $_.FriendlyName -eq $FriendlyName } |
      ForEach-Object { Write-Host "  suppression du certificat $($_.Thumbprint)"; Remove-Item $_.PSPath -Force }
  }
  Write-Host "Termine." -ForegroundColor Green
  exit 0
}

Assert-Admin

# --- 1. le package le plus recent -------------------------------------------
$appx = Get-ChildItem "dist\installer\MicrosoftStore\*.appx" |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $appx) { Write-Host "Aucun .appx trouve. Lance d'abord: npm run build:msix" -ForegroundColor Red; exit 1 }
Write-Host "== Package : $($appx.Name)  ($([math]::Round($appx.Length/1MB)) Mo)" -ForegroundColor Cyan

# --- 2. certificat de test ---------------------------------------------------
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Publisher } | Select-Object -First 1
if (-not $cert) {
  Write-Host "== Creation du certificat de test ($Publisher)"
  $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher `
    -KeyUsage DigitalSignature -FriendlyName $FriendlyName `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
} else {
  Write-Host "== Certificat de test deja present ($($cert.Thumbprint))"
}

# --- 3. confiance machine ----------------------------------------------------
$pwd  = ConvertTo-SecureString -String ([guid]::NewGuid().ToString()) -Force -AsPlainText
$pfx  = Join-Path $env:TEMP 'fabmesh_test_cert.pfx'
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $pfx -Password $pwd | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' -Password $pwd | Out-Null
Write-Host "== Certificat ajoute aux Personnes de confiance"

# --- 4. signature ------------------------------------------------------------
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) {
  $signtool = Get-ChildItem "$env:LOCALAPPDATA\..\..\*\node_modules\app-builder-bin\win\x64\signtool.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $signtool) { Write-Host "signtool.exe introuvable (installe le Windows SDK)." -ForegroundColor Red; exit 1 }

$signed = Join-Path $env:TEMP ('signed_' + $appx.Name)
Copy-Item $appx.FullName $signed -Force
& $signtool.FullName sign /fd SHA256 /a /f $pfx /p ([Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwd))) $signed
if ($LASTEXITCODE -ne 0) { Write-Host "Echec de la signature." -ForegroundColor Red; exit 1 }
Write-Host "== Package signe" -ForegroundColor Green

# --- 5. installation ---------------------------------------------------------
# L'ANCIEN PAQUET DOIT VRAIMENT PARTIR, ET EN CAS D'ECHEC ON DOIT LE VOIR.
# Le 2026-08-28, un 1.0.33 sideloade le 20/08 etait reste installe :
# Remove-AppxPackage echouait (l'app tournait encore) mais SilentlyContinue
# avalait l'erreur, et Add-AppxPackage sortait en 0x80073CFB « meme identite,
# contenu different ». On arrete d'abord les processus, on retire, et on
# VERIFIE que la desinstallation a bien eu lieu avant d'installer.
Get-Process -Name 'MyFabmesh*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Get-AppxPackage -Name "*MyFabmesh*" | ForEach-Object {
  Write-Host "  desinstallation de $($_.PackageFullName)"
  Remove-AppxPackage $_.PackageFullName
}
$restant = Get-AppxPackage -Name "*MyFabmesh*"
if ($restant) {
  Write-Host "Un paquet MyFabmesh est TOUJOURS installe : $($restant.PackageFullName)" -ForegroundColor Red
  Write-Host "Installer par-dessus echouerait en 0x80073CFB. Abandon." -ForegroundColor Red
  exit 1
}
Add-AppxPackage -Path $signed
Remove-Item $pfx -Force -ErrorAction SilentlyContinue

$installed = Get-AppxPackage -Name "*MyFabmesh*"
if ($installed) {
  Write-Host ""
  Write-Host "INSTALLATION REUSSIE : $($installed.Name) $($installed.Version)" -ForegroundColor Green
  Write-Host "  -> lance l'app depuis le MENU DEMARRER (les apps MSIX n'ont pas de raccourci bureau)"
  Write-Host "  -> dossier d'install : $($installed.InstallLocation)"
  Write-Host ""
  Write-Host "Pour simuler une machine SANS GPU (le cas des testeurs Microsoft) :" -ForegroundColor Yellow
  Write-Host '  setx FABMESH_FORCE_NO_GPU 1   (puis relance l app, et supprime la variable ensuite)'
} else {
  Write-Host "Installation echouee." -ForegroundColor Red
}
