; "Open with vrtti" on Windows without claiming a file type
; (architecture.md §24). Tauri's NSIS template includes this file through
; bundle.windows.nsis.installerHooks (tauri.windows.conf.json) and inserts
; the NSIS_HOOK_* macros in its install and uninstall sections. The include
; comes before the template's own defines, so nothing here may expand
; ${MAINBINARYNAME} or ${PRODUCTNAME} at file level: inside a macro they
; expand at insertion time, when they exist. SHCTX follows the install mode
; (HKCU for the per-user install the updater uses, HKLM machine-wide).
;
; Software\Classes\Applications\<exe> is what Explorer lists under
; "Choose another app" for every file type, and what a Shift+drop on the
; taskbar button launches. OpenWithList under an extension puts the app in
; that type's short "Open with" submenu. Neither writes the extension's
; default value, so the current default handler stays. The step after this
; one, bundle.fileAssociations on Windows, is deliberately not taken yet.

; The editor's extensions (app/js/editor/lang.js, BY_EXTENSION) plus the
; plain-text family. Keep equal to the fileAssociations in
; tauri.linux.conf.json and tauri.macos.conf.json; the cargo test
; platform_configs_parse checks that every extension there appears here.
!macro VRTTI_EACH_EXT MACRO
  !insertmacro ${MACRO} "md"
  !insertmacro ${MACRO} "markdown"
  !insertmacro ${MACRO} "txt"
  !insertmacro ${MACRO} "text"
  !insertmacro ${MACRO} "js"
  !insertmacro ${MACRO} "mjs"
  !insertmacro ${MACRO} "cjs"
  !insertmacro ${MACRO} "jsx"
  !insertmacro ${MACRO} "ts"
  !insertmacro ${MACRO} "tsx"
  !insertmacro ${MACRO} "html"
  !insertmacro ${MACRO} "htm"
  !insertmacro ${MACRO} "css"
  !insertmacro ${MACRO} "json"
  !insertmacro ${MACRO} "cs"
!macroend

!macro VRTTI_OPEN_WITH_ADD EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithList\${MAINBINARYNAME}.exe" "" ""
!macroend

; Only what the install wrote: the extension key itself stays unless vrtti
; was its only content.
!macro VRTTI_OPEN_WITH_REMOVE EXT
  DeleteRegKey SHCTX "Software\Classes\.${EXT}\OpenWithList\${MAINBINARYNAME}.exe"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithList"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open" "" "Open with ${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  !insertmacro VRTTI_EACH_EXT VRTTI_OPEN_WITH_ADD
  ; Explorer rebuilds its Open with menus (FileAssociation.nsh, included by
  ; the template).
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro VRTTI_EACH_EXT VRTTI_OPEN_WITH_REMOVE
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  !insertmacro UPDATEFILEASSOC
!macroend
