; MyFabmesh.AI — custom NSIS uninstaller hook
;
; Runs during uninstall and asks the user, in THREE independent steps, what
; to also remove. Every prompt DEFAULTS TO "No" (/SD IDNO) so a silent /
; distracted uninstall NEVER destroys the user's creations.
;
;   1. AI models cache (~17 GB, HuggingFace) — re-downloadable.
;   2. Generated content (projects/images + 3D meshes) — the user's creations.
;   3. Settings (config + logs).
;
; NOTE on paths: the packaged app's data lives under userData =
;   %APPDATA%\myfabmesh-ai\   (Electron uses the package `name`, not "fabmesh").
; meshes/, images/, previews/, history/ are SUBFOLDERS of that userData dir.
; (If the user relocated heavy data via config.dataDir to another drive, that
;  custom folder is left untouched here — only the default location is cleaned.)
;
; Hooked via package.json -> build.nsis.include

!macro customUnInstall
  ; ----- 1) AI models cache (~17 GB)? -----
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also delete the AI models cache (~17 GB)?$\r$\n$\r$\nKeep it (No) to reinstall MyFabmesh.AI later WITHOUT re-downloading the models." \
    /SD IDNO IDNO skipModels
    RMDir /r "$PROFILE\.cache\huggingface\hub"
    RMDir /r "$PROFILE\.cache\realesrgan_weights"
  skipModels:

  ; ----- 2) Generated content (projects, images, 3D meshes)? -----
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also delete ALL your generated content?$\r$\n$\r$\nThis removes your projects, source images and 3D meshes.$\r$\nChoose No to KEEP your creations for after a reinstall." \
    /SD IDNO IDNO skipGenerated
    RMDir /r "$APPDATA\myfabmesh-ai\meshes"
    RMDir /r "$APPDATA\myfabmesh-ai\images"
    RMDir /r "$APPDATA\myfabmesh-ai\previews"
    RMDir /r "$APPDATA\myfabmesh-ai\history"
  skipGenerated:

  ; ----- 3) Settings (config + logs)? -----
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also delete your MyFabmesh.AI settings (config + logs)?$\r$\n$\r$\nYour generated content is not affected by this choice." \
    /SD IDNO IDNO skipConfig
    Delete "$APPDATA\myfabmesh-ai\config.json"
    Delete "$APPDATA\myfabmesh-ai\setup_state.json"
    RMDir /r "$APPDATA\myfabmesh-ai\logs"
    RMDir /r "$APPDATA\fabmesh"   ; legacy early-boot startup.log dir
  skipConfig:

  ; ----- Always remove these app-internal token files -----
  Delete "$INSTDIR\.mcp_bridge_token"
  Delete "$INSTDIR\.test_api_token"
!macroend
