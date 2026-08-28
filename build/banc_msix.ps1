# =============================================================================
# banc_msix.ps1 -- reproduction FIDELE de ce que vit un testeur du Store.
# -----------------------------------------------------------------------------
# WACK ne teste PAS le demarrage : pour un paquet Centennial il annonce
# "Running tests without application deployment" et fait de l'analyse statique.
# Aucun des six refus de certification n'aurait ete attrape par lui. Ce banc,
# lui, installe le vrai conteneur MSIX et regarde l'application demarrer.
#
# LES DEUX PIEGES DE FIDELITE, appris a la dure le 2026-08-16 :
#
#   1. LE CHEMIN DU TESTEUR EST CELUI QU'ON NE TESTE JAMAIS.
#      `_detectAlreadyInstalled()` regarde
#      ~/.cache/huggingface/hub/models--microsoft--TRELLIS.2-4B. Sur la machine
#      de dev il EXISTE, donc l'assistant d'installation est saute. Sur la
#      machine du testeur il n'existe pas, donc il passe TOUJOURS par
#      l'assistant. Ce script masque donc le dossier (renommage, instantane et
#      reversible) avant d'installer, et le restaure quoi qu'il arrive.
#
#   2. LES JOURNAUX NE SONT PAS OU ON CROIT.
#      La virtualisation MSIX : si %APPDATA%\fabmesh existe deja, l'app
#      packagee ecrit dedans ; sinon tout part dans
#      %LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\. Chercher au mauvais
#      endroit fait conclure a tort que le logger n'a pas tourne. On regarde
#      LES DEUX.
#
# USAGE (PowerShell ADMINISTRATEUR) :
#   cd C:\Users\Utilisateur\Desktop\FabWare\MeshyMyself
#   powershell -ExecutionPolicy Bypass -File build\banc_msix.ps1
#
# Le cache HuggingFace est TOUJOURS restaure, y compris si le script echoue
# ou si tu l'interromps -- c'est un renommage, aucune donnee n'est copiee.
# =============================================================================
param([int]$AttenteSecondes = 90)

$ErrorActionPreference = 'Stop'
$racine = Split-Path -Parent $PSScriptRoot
$cacheHF = Join-Path $env:USERPROFILE '.cache\huggingface\hub\models--microsoft--TRELLIS.2-4B'
$cacheMasque = $cacheHF + '.BANC_MASQUE'
$masque = $false

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Bon($m)  { Write-Host $m -ForegroundColor Green }
function Mauvais($m) { Write-Host $m -ForegroundColor Red }

$estAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $estAdmin) {
  Mauvais "Ce script doit tourner dans un PowerShell ADMINISTRATEUR."
  exit 1
}

try {
  # --- PIEGE 1 : forcer le chemin de l'assistant ------------------------------
  if (Test-Path $cacheHF) {
    Info "== Masquage du cache HuggingFace (renommage, reversible)"
    if (Test-Path $cacheMasque) { Remove-Item $cacheMasque -Recurse -Force }
    Rename-Item $cacheHF $cacheMasque
    $masque = $true
    Bon "   le paquet verra une machine SANS modeles -- comme celle du testeur"
  } else {
    Info "== Cache HuggingFace absent : le chemin assistant est deja celui teste"
  }

  # --- Installation du vrai conteneur ----------------------------------------
  Info "== Installation du paquet (signature de test + Add-AppxPackage)"
  & powershell -ExecutionPolicy Bypass -File (Join-Path $racine 'build\test_install_msix.ps1')
  if ($LASTEXITCODE -ne 0) { throw "l'installation a echoue (code $LASTEXITCODE)" }

  $pkg = Get-AppxPackage -Name "*MyFabmesh*" | Select-Object -First 1
  if (-not $pkg) { throw "paquet introuvable apres installation" }
  Bon "   installe : $($pkg.Name) $($pkg.Version)"

  # --- Lancement comme un vrai utilisateur -----------------------------------
  $aumid = (Get-AppxPackageManifest $pkg).Package.Applications.Application.Id
  $cible = "shell:AppsFolder\$($pkg.PackageFamilyName)!$aumid"
  Info "== Lancement : $cible"

  $avant = @(Get-Process -Name 'MyFabmesh*' -ErrorAction SilentlyContinue).Count
  $t0 = Get-Date
  Start-Process $cible
  Info "   observation pendant $AttenteSecondes s..."

  # --- Observation : une fenetre VISIBLE apparait-elle, et laquelle ? ---------
  Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static string Fenetres(uint[] pids) {
    var sb = new StringBuilder();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h); if (n == 0) return true;
      var t = new StringBuilder(n + 1); GetWindowText(h, t, n + 1);
      sb.AppendLine("    [" + pid + "] " + t.ToString());
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
'@
  $premiereFenetre = $null
  $titres = ''
  for ($i = 0; $i -lt $AttenteSecondes; $i++) {
    Start-Sleep -Seconds 1
    $procs = @(Get-Process -Name 'MyFabmesh*' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { continue }
    $titres = [W]::Fenetres([uint[]]($procs | ForEach-Object { [uint32]$_.Id }))
    if ($titres -and -not $premiereFenetre) {
      $premiereFenetre = ((Get-Date) - $t0).TotalMilliseconds
      Bon ("   FENETRE VISIBLE a t=" + [math]::Round($premiereFenetre) + " ms")
    }
  }

  $procs = @(Get-Process -Name 'MyFabmesh*' -ErrorAction SilentlyContinue)
  Write-Host ""
  Info "== RESULTAT"
  Write-Host "   processus avant/apres : $avant -> $($procs.Count)"
  if ($premiereFenetre) {
    Write-Host "   premiere fenetre visible : $([math]::Round($premiereFenetre)) ms"
  } else {
    Mauvais "   AUCUNE FENETRE VISIBLE en $AttenteSecondes s -- c'est 'crashes at launch'"
  }
  Write-Host "   fenetres :"
  if ($titres) { Write-Host $titres } else { Write-Host "    (aucune)" }

  # L'ASSISTANT DOIT APPARAITRE : c'est tout l'objet du masquage.
  if ($titres -match 'Setup|Welcome|assistant|Bienvenue') {
    Bon "   L'ASSISTANT D'INSTALLATION EST LA -- chemin du testeur reproduit"
  } elseif ($titres) {
    Mauvais "   Fenetre presente mais PAS l'assistant, alors que les modeles"
    Mauvais "   sont masques : c'est le defaut signale par le user."
  }
  if ($titres -match 'could not start normally') {
    Mauvais "   FENETRE ROUGE D'ECHEC -- un testeur ecrit 'crashes at launch'"
  }

  # --- PIEGE 2 : chercher le journal AUX DEUX ENDROITS ------------------------
  Write-Host ""
  Info "== Journaux (virtualisation MSIX : deux emplacements possibles)"
  $lieux = @(
    (Join-Path $env:APPDATA 'fabmesh'),
    (Join-Path $env:LOCALAPPDATA "Packages\$($pkg.PackageFamilyName)\LocalCache\Roaming\fabmesh")
  )
  foreach ($l in $lieux) {
    if (Test-Path $l) {
      $f = Get-ChildItem $l -Filter '*.log' -Recurse -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($f) {
        Bon "   $($f.FullName)  ($([math]::Round($f.Length/1KB)) ko, $($f.LastWriteTime))"
        Write-Host "   --- 15 dernieres lignes ---"
        Get-Content $f.FullName -Tail 15 | ForEach-Object { Write-Host "   $_" }
      } else { Write-Host "   $l : aucun .log" }
    } else { Write-Host "   $l : absent" }
  }
}
finally {
  # --- Restauration, MEME en cas d'echec ou d'interruption --------------------
  if ($masque -and (Test-Path $cacheMasque)) {
    Write-Host ""
    Info "== Restauration du cache HuggingFace"
    if (Test-Path $cacheHF) { Remove-Item $cacheHF -Recurse -Force }
    Rename-Item $cacheMasque $cacheHF
    Bon "   restaure : $cacheHF"
  }
  Write-Host ""
  Write-Host "Pour desinstaller le paquet de test :"
  Write-Host "  powershell -ExecutionPolicy Bypass -File build\test_install_msix.ps1 -Cleanup"
}
