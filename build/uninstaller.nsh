; MyFabmesh.AI — custom NSIS uninstaller hook
;
; The app launches the uninstaller SILENTLY (/S) after asking everything in a
; nice in-app popup (no ugly native Windows dialogs). The three delete choices
; are passed as environment variables and read here:
;
;   FABMESH_UNINST_MODELS    = "1" -> delete the AI models cache (~17 GB, HF)
;   FABMESH_UNINST_GENERATED = "1" -> delete generated content (projects/images/meshes)
;   FABMESH_UNINST_SETTINGS  = "1" -> delete settings (config + logs)
;
; Each defaults to "0" (KEEP) when the var is unset, so a bare /S uninstall or
; a manual run from Add/Remove Programs never destroys the user's creations.
;
; NOTE on paths: the packaged app's data lives under userData =
;   %APPDATA%\myfabmesh-ai\  (Electron uses the package `name`, not "fabmesh").
; meshes/, images/, previews/, history/ are SUBFOLDERS of that userData dir.
; (If the user relocated heavy data via config.dataDir to another drive, that
;  custom folder is left untouched here — only the default location is cleaned.)
;
; Hooked via package.json -> build.nsis.include

!macro customUnInstall
  ; ----- 1) AI models cache (~17 GB)? -----
  ReadEnvStr $0 "FABMESH_UNINST_MODELS"
  ${If} $0 == "1"
    RMDir /r "$PROFILE\.cache\huggingface\hub"
    RMDir /r "$PROFILE\.cache\realesrgan_weights"
  ${EndIf}

  ; ----- 2) Generated content (projects, images, 3D meshes)? -----
  ReadEnvStr $1 "FABMESH_UNINST_GENERATED"
  ${If} $1 == "1"
    RMDir /r "$APPDATA\myfabmesh-ai\meshes"
    RMDir /r "$APPDATA\myfabmesh-ai\images"
    RMDir /r "$APPDATA\myfabmesh-ai\previews"
    RMDir /r "$APPDATA\myfabmesh-ai\history"
  ${EndIf}

  ; ----- 3) Settings (config + logs)? -----
  ReadEnvStr $2 "FABMESH_UNINST_SETTINGS"
  ${If} $2 == "1"
    Delete "$APPDATA\myfabmesh-ai\config.json"
    Delete "$APPDATA\myfabmesh-ai\setup_state.json"
    RMDir /r "$APPDATA\myfabmesh-ai\logs"
    RMDir /r "$APPDATA\fabmesh"   ; legacy early-boot startup.log dir
  ${EndIf}

  ; ----- Always remove these app-internal token files -----
  Delete "$INSTDIR\.mcp_bridge_token"
  Delete "$INSTDIR\.test_api_token"
!macroend
