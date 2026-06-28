; Custom NSIS script for QuotaBar — auto-included by electron-builder
; (default include path: build/installer.nsh).

; During uninstall, ask whether to also remove user data.
; QuotaBar stores everything under %USERPROFILE%\.quotabar-win
; (settings, usage history, debug logs, caches) — NOT in %APPDATA%,
; so electron-builder's deleteAppDataOnUninstall does not cover it.
; Default answer is No, so data survives an uninstall/reinstall unless
; the user explicitly opts in.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you also want to remove all QuotaBar data and settings?$\n$\nThis permanently deletes your usage history, settings and caches in:$\n$PROFILE\.quotabar-win$\n$\nChoose No to keep your data for a future reinstall." \
    /SD IDNO IDNO keepData
    RMDir /r "$PROFILE\.quotabar-win"
  keepData:
!macroend
