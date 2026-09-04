# Prepare le PC de developpement au reveil par le reseau (Wake-on-LAN).
#
# A LANCER EN ADMINISTRATEUR :
#   powershell -ExecutionPolicy Bypass -File outils\configurer-wake-on-lan.ps1
#
# Ce que le script regle COTE WINDOWS (mesure le 2026-09-04) :
#   1. Le Demarrage rapide (Fast Startup) etait ACTIF. A l'arret, Windows
#      hiberne alors le noyau au lieu d'eteindre proprement, et la carte
#      reseau n'est pas laissee dans l'etat qui ecoute le paquet magique :
#      c'est LA cause n1 des WoL qui " marchent depuis la veille mais pas
#      depuis l'arret ". On le desactive (HiberbootEnabled = 0). L'hibernation
#      manuelle reste disponible.
#   2. La carte Realtek est autorisee a reveiller la machine (powercfg), et
#      ses deux proprietes pilotes sont forcees : " Reveil sur Magic Packet "
#      et " Arreter Reveil par reseau " (= reveil depuis l'etat eteint, S5).
#      Les deux etaient deja actives ; on les verrouille pour qu'une mise a
#      jour de pilote ne les remette pas a zero en silence.
#
# Ce que le script NE PEUT PAS faire, et qui reste a toi (une fois) :
#   BIOS/UEFI de la carte mere ASUS PRIME Z790-P WIFI (BIOS 1825) :
#     Advanced > APM Configuration >
#       - " Power On By PCI-E "  : Enabled   <- c'est le WoL sur ASUS
#       - " ErP Ready "          : Disabled  <- ErP coupe l'alim de la carte reseau a l'arret
#     (Selon la version : Advanced > Onboard Devices Configuration >
#       " Realtek LAN Controller " : Enabled.)
#   Sans " Power On By PCI-E ", rien de ce qui suit ne peut fonctionner.
#
# Depuis l'EXTERIEUR du reseau (claude.ai depuis ailleurs), un paquet magique
# ne traverse pas la box par defaut : il faut une redirection du port UDP 9
# vers l'adresse de diffusion 192.168.1.255 dans l'interface de la box, ou
# passer par une machine deja allumee sur le reseau. C'est une decision de
# securite qui t'appartient ; le script ne touche pas a la box.

$ErrorActionPreference = 'Stop'

$estAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $estAdmin) {
  Write-Host "Ce script doit tourner dans un PowerShell ADMINISTRATEUR." -ForegroundColor Red
  exit 1
}

function Etat($m) { Write-Host $m -ForegroundColor Cyan }
function Bon($m)  { Write-Host $m -ForegroundColor Green }

$cle = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
$carte = Get-NetAdapter -Physical | Where-Object { $_.InterfaceDescription -like 'Realtek*' -and $_.Status -eq 'Up' } | Select-Object -First 1
if (-not $carte) { Write-Host "Carte Realtek introuvable ou deconnectee." -ForegroundColor Red; exit 1 }

Etat "== AVANT"
$avant = (Get-ItemProperty $cle -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
Write-Host "   Demarrage rapide (HiberbootEnabled) : $avant"
Write-Host "   Carte : $($carte.Name) -- $($carte.InterfaceDescription) -- $($carte.MacAddress)"
Get-NetAdapterAdvancedProperty -Name $carte.Name | Where-Object { $_.RegistryKeyword -in '*WakeOnMagicPacket','WakeOnMagicPacket','S5WakeOnLan','*S5WakeOnLan' } |
  ForEach-Object { Write-Host ("   {0,-32} {1}" -f $_.DisplayName, $_.DisplayValue) }

Etat "== REGLAGES"
# 1. Demarrage rapide OFF (l'hibernation manuelle reste possible)
Set-ItemProperty $cle -Name HiberbootEnabled -Value 0 -Type DWord
Bon "   Demarrage rapide desactive"

# 2. La carte peut reveiller la machine
powercfg /deviceenablewake "$($carte.InterfaceDescription)" | Out-Null
Bon "   Carte autorisee a reveiller le PC (powercfg)"

# 3. Proprietes pilote : Magic Packet + reveil depuis l'arret (S5).
#    Les mots-cles de registre varient selon la version du pilote Realtek ;
#    on essaie les deux orthographes et on ignore celles qui n'existent pas.
foreach ($kw in '*WakeOnMagicPacket', 'WakeOnMagicPacket', 'S5WakeOnLan', '*S5WakeOnLan') {
  try {
    Set-NetAdapterAdvancedProperty -Name $carte.Name -RegistryKeyword $kw -RegistryValue 1 -NoRestart -ErrorAction Stop
    Bon "   $kw = 1"
  } catch { }
}
# Eviter que Windows coupe l'alimentation de la carte pour economiser
try {
  Disable-NetAdapterPowerManagement -Name $carte.Name -DeviceSleepOnDisconnect -NoRestart -ErrorAction Stop
  Bon "   Pas de mise en veille de la carte a la deconnexion"
} catch { }

Etat "== APRES"
$apres = (Get-ItemProperty $cle -Name HiberbootEnabled).HiberbootEnabled
Write-Host "   Demarrage rapide (HiberbootEnabled) : $apres"
Get-NetAdapterAdvancedProperty -Name $carte.Name | Where-Object { $_.DisplayName -match 'Magic|R.veil|Wake' } |
  ForEach-Object { Write-Host ("   {0,-32} {1}" -f $_.DisplayName, $_.DisplayValue) }
Write-Host "   Peripheriques armes pour le reveil :"
powercfg /devicequery wake_armed | Where-Object { $_ -match 'Realtek' } | ForEach-Object { Write-Host "     $_" }

Write-Host ""
Write-Host "RESTE A FAIRE UNE FOIS, DANS LE BIOS (touche Suppr au demarrage) :" -ForegroundColor Yellow
Write-Host "   Advanced > APM Configuration > Power On By PCI-E = Enabled"
Write-Host "   Advanced > APM Configuration > ErP Ready         = Disabled"
Write-Host ""
Write-Host "TEST : eteins le PC (pas veille), puis depuis une autre machine du reseau :"
Write-Host "   powershell -ExecutionPolicy Bypass -File outils\wake-pc.ps1"
