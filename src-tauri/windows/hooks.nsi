; RCQ installer hooks (Windows/NSIS only).
;
; The bundled sing-box runs as our child process, but it can outlive the app
; - and Windows will not delete or overwrite a running executable. A
; reinstall then stops dead on a locked sing-box.exe until the user hunts it
; down in Task Manager (#647). Both hooks put OUR copy down before files are
; touched; the bypass setting survives, so the tunnel returns on the next
; launch (same contract as bypass_halt in lib.rs).
;
; Filtered by path on purpose: this audience runs its own proxy tooling, and
; an installer that taskkills every sing-box.exe on the machine would take a
; user's personal tunnel down with it. Only processes started from the
; install directory qualify.

!macro StopBundledSingBox
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '$INSTDIR*' } | Stop-Process -Force"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopBundledSingBox
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopBundledSingBox
!macroend
