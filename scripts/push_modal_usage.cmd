@echo off
REM ---------------------------------------------------------------------
REM Remonte la facturation Modal REELLE vers le dashboard admin.
REM Lance chaque heure par la tache planifiee « MyFabmesh - Modal usage ».
REM
REM POURQUOI : sans ce poller, _meta/modal_real_usage.json n'est jamais
REM ecrit. Le dashboard retombe alors sur ses ESTIMATIONS, et l'alerte
REM « budget Modal bientot epuise » n'a aucune donnee fraiche a comparer.
REM Le flux etait gele depuis 46 jours sans que rien ne le signale (c'est
REM desormais visible : la carte passe en rouge « PERIME » au-dela de 48 h).
REM
REM Le secret n'est PAS dans le depot : il vit dans le profil utilisateur,
REM au meme endroit que le jeton de l'API de controle.
REM ---------------------------------------------------------------------
setlocal

set "REPO=%~dp0.."
set "SECRET_FILE=%USERPROFILE%\.fabmesh\modal_usage_secret.txt"
set "LOG=%USERPROFILE%\.fabmesh\modal_usage.log"

if not exist "%SECRET_FILE%" (
  echo [%date% %time%] ECHEC : %SECRET_FILE% introuvable >> "%LOG%"
  exit /b 2
)

set /p MODAL_USAGE_SECRET=<"%SECRET_FILE%"
set "PYTHONUTF8=1"

cd /d "%REPO%"
python scripts\modal_usage_push.py >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%
echo [%date% %time%] exit=%RC% >> "%LOG%"

REM On garde le journal borne : sans ca il grossit indefiniment.
for %%A in ("%LOG%") do if %%~zA GTR 1000000 (
  move /y "%LOG%" "%LOG%.old" >nul 2>&1
)

exit /b %RC%
