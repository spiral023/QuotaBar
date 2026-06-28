; Custom NSIS script for QuotaBar — auto-included by electron-builder
; (default include path: build/installer.nsh).

; electron-builder's assisted installer shows no Welcome page by default,
; so the installerSidebar image would only appear on the Finish page.
; Adding the Welcome page here makes the sidebar visible right at the start
; and lets us greet the user with custom copy.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to QuotaBar"
  !define MUI_WELCOMEPAGE_TEXT "QuotaBar lives in your system tray and keeps an eye on your AI coding quota — across Claude and Codex — so you always know how much you have left.$\r$\n$\r$\nEverything runs locally on your machine. No account, no cloud, nothing leaves your computer.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

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
