# Reveille le PC de developpement par Wake-on-LAN (paquet magique).
#
# A lancer DEPUIS UNE AUTRE MACHINE du meme reseau local (le PC eteint ne
# peut evidemment pas se reveiller lui-meme). Depuis l'exterieur du reseau,
# il faut que la box redirige le port UDP 9 vers l'adresse de diffusion --
# voir la note dans configurer-wake-on-lan.ps1.
#
#   powershell -ExecutionPolicy Bypass -File outils\wake-pc.ps1
#   powershell -ExecutionPolicy Bypass -File outils\wake-pc.ps1 -Mac "A0-AD-9F-13-22-7F" -Broadcast 192.168.1.255
#
# Le paquet magique = 6 octets 0xFF suivis de l'adresse MAC repetee 16 fois,
# envoye en UDP sur l'adresse de diffusion. La carte, restee alimentee en
# veille ou a l'arret, le reconnait et allume la machine.
param(
  [string]$Mac = 'A0-AD-9F-13-22-7F',     # Realtek Gaming 2.5GbE du PC de dev (mesure le 2026-09-04)
  [string]$Broadcast = '192.168.1.255',   # reseau 192.168.1.0/24
  [int]$Port = 9
)

$octets = $Mac -split '[-:]' | ForEach-Object { [Convert]::ToByte($_, 16) }
if ($octets.Count -ne 6) { Write-Host "Adresse MAC invalide : $Mac" -ForegroundColor Red; exit 1 }

$paquet = [byte[]](,0xFF * 6) + ([byte[]]$octets * 16)

$udp = New-Object System.Net.Sockets.UdpClient
$udp.EnableBroadcast = $true
try {
  # Trois envois : un paquet UDP peut se perdre, et ca ne coute rien.
  1..3 | ForEach-Object {
    [void]$udp.Send($paquet, $paquet.Length, $Broadcast, $Port)
    Start-Sleep -Milliseconds 200
  }
  Write-Host "Paquet magique envoye a $Mac via $Broadcast`:$Port (x3)." -ForegroundColor Green
  Write-Host "Compte 30 a 60 s pour le demarrage, puis la session Claude Code se lance seule."
} finally {
  $udp.Close()
}
