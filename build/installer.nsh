!macro yutianKillProcessByImage IMAGE_NAME
  DetailPrint "Closing running ${IMAGE_NAME} processes..."
  nsExec::ExecToLog `"$SYSDIR\taskkill.exe" /F /T /IM "${IMAGE_NAME}"`
  Pop $0
  ClearErrors
!macroend

!macro yutianKillProcessesUnderDir TARGET_DIR
  ${if} "${TARGET_DIR}" != ""
    DetailPrint "Closing YuTianClaw processes under: ${TARGET_DIR}"
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue'; $$root='${TARGET_DIR}'; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $0
    ClearErrors
  ${endif}
!macroend

!macro yutianCloseKnownProcesses
  !insertmacro yutianKillProcessByImage "YuTianClaw.exe"

  ReadRegStr $R7 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro yutianKillProcessesUnderDir "$R7"

  ReadRegStr $R7 HKEY_LOCAL_MACHINE "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro yutianKillProcessesUnderDir "$R7"

  !insertmacro yutianKillProcessesUnderDir "$LOCALAPPDATA\Programs\YuTianClaw"
  !insertmacro yutianKillProcessesUnderDir "$PROGRAMFILES\YuTianClaw"
  !ifdef PROGRAMFILES64
    !insertmacro yutianKillProcessesUnderDir "$PROGRAMFILES64\YuTianClaw"
  !endif

  Sleep 1000
!macroend

!macro yutianRunOldUninstaller INSTALL_DIR INSTALL_MODE
  ${if} "${INSTALL_DIR}" != ""
  ${andIf} ${FileExists} "${INSTALL_DIR}\${UNINSTALL_FILENAME}"
    DetailPrint "Uninstalling previous YuTianClaw from: ${INSTALL_DIR}"
    ExecWait `"${INSTALL_DIR}\${UNINSTALL_FILENAME}" /S /KEEP_APP_DATA ${INSTALL_MODE} --updated _?=${INSTALL_DIR}` $R0
    DetailPrint "Previous uninstaller exit code: $R0"
    ClearErrors
  ${endif}
!macroend

!macro yutianRemoveDefaultInstallDir INSTALL_DIR
  ${if} ${FileExists} "${INSTALL_DIR}\*.*"
    DetailPrint "Cleaning stale YuTianClaw install directory: ${INSTALL_DIR}"
    SetOutPath "$TEMP"
    RMDir /r "${INSTALL_DIR}"
    ClearErrors
  ${endif}
!macroend

!macro yutianCleanupKnownOldInstalls
  !insertmacro yutianCloseKnownProcesses

  ReadRegStr $R7 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro yutianRunOldUninstaller "$R7" "/currentuser"

  ReadRegStr $R7 HKEY_LOCAL_MACHINE "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro yutianRunOldUninstaller "$R7" "/allusers"

  !insertmacro yutianRunOldUninstaller "$LOCALAPPDATA\Programs\YuTianClaw" "/currentuser"
  !insertmacro yutianRunOldUninstaller "$PROGRAMFILES\YuTianClaw" "/allusers"
  !ifdef PROGRAMFILES64
    !insertmacro yutianRunOldUninstaller "$PROGRAMFILES64\YuTianClaw" "/allusers"
  !endif

  !insertmacro yutianCloseKnownProcesses

  !insertmacro yutianRemoveDefaultInstallDir "$LOCALAPPDATA\Programs\YuTianClaw"
  !insertmacro yutianRemoveDefaultInstallDir "$PROGRAMFILES\YuTianClaw"
  !ifdef PROGRAMFILES64
    !insertmacro yutianRemoveDefaultInstallDir "$PROGRAMFILES64\YuTianClaw"
  !endif
!macroend

!macro yutianSilentWhenUpdated
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    DetailPrint "YuTianClaw update mode detected; switching installer to silent mode."
    SetSilent silent
  ${EndIf}
  ClearErrors
!macroend

!macro customInit
  !insertmacro yutianSilentWhenUpdated
  !insertmacro yutianCleanupKnownOldInstalls
!macroend

!macro customCheckAppRunning
  !insertmacro yutianCloseKnownProcesses
!macroend

!macro yutianForceCleanupAfterOldUninstall
  ${if} $R0 != 0
    DetailPrint "Previous YuTianClaw uninstaller returned $R0; cleaning remaining files."
    SetOutPath "$TEMP"
    RMDir /r "$INSTDIR"
    ClearErrors
    StrCpy $R0 0
  ${endif}
!macroend

!macro customUnInstallCheck
  !insertmacro yutianForceCleanupAfterOldUninstall
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro yutianForceCleanupAfterOldUninstall
!macroend
