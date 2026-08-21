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
; user's personal tunnel down with it. Only the executable INSIDE the install
; directory qualifies.

!macro StopBundledSingBox
  ; The comparison is an exact full-path match against $INSTDIR\sing-box.exe,
  ; not a prefix:
  ;   * a prefix without a trailing separator ("C:\Program Files\RCQ*") also
  ;     matches a sibling directory like "C:\Program Files\RCQ-nightly", whose
  ;     sing-box belongs to somebody else;
  ;   * -like is a wildcard operator, so an install path containing [ or ] is
  ;     read as a character class and silently matches nothing.
  ; -eq on the full path has neither problem. The path is passed through an
  ; environment variable rather than interpolated into the PowerShell string,
  ; so an apostrophe in the path (C:\Users\O'Brien\...) cannot end the quoted
  ; literal and break the filter.
  System::Call 'kernel32::SetEnvironmentVariable(t "RCQ_SB_PATH", t "$INSTDIR\sing-box.exe")i.r0'
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:RCQ_SB_PATH } | Stop-Process -Force"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopBundledSingBox
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopBundledSingBox
!macroend
