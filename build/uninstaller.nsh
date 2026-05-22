; MyFabmesh.AI — custom NSIS uninstaller hook
;
; Runs during uninstall to ask the user whether they also want to
; remove the AI models cache (~17 GB) and their settings folder.
; Generated meshes (Documents\MyFabmesh.AI\) are always kept.
;
; Hooked via package.json -> build.nsis.include

!macro customUnInstall
  ; ----- Ask: also remove AI models? -----
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also delete the AI models cache (~17 GB)?$\r$\n$\r$\nYou can reinstall MyFabmesh.AI later without re-downloading them by keeping this folder." \
    /SD IDNO IDNO skipModels
    ; User clicked YES — remove HF cache
    RMDir /r "$PROFILE\.cache\huggingface\hub"
    RMDir /r "$PROFILE\.cache\realesrgan_weights"
  skipModels:

  ; ----- Ask: also remove settings? -----
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also delete your MyFabmesh.AI settings (in AppData)?$\r$\n$\r$\nYour generated meshes in Documents are not affected." \
    /SD IDNO IDNO skipConfig
    RMDir /r "$APPDATA\fabmesh"
  skipConfig:

  ; ----- Always remove these app-internal files -----
  Delete "$INSTDIR\.mcp_bridge_token"
  Delete "$INSTDIR\.test_api_token"
!macroend
