# 无为安装器定制脚本（electron-builder nsis.include 注入）
#
# 覆盖 electron-builder 26.x 默认的「应用是否在运行」检测（_CHECK_APP_RUNNING），修两处缺陷：
#
#  1) 默认实现的 PowerShell 分支按「进程可执行文件路径位于 $INSTDIR 下」判定应用在运行，
#     但没有排除安装程序自身的 PID —— 同一个文件里的 tasklist 分支是有 /FI "PID ne $pid" 的。
#     结果：只要安装包被放进安装目录（或用户把安装目录选成安装包所在目录），它就会检测到
#     自己，弹「无法关闭，请手动关闭后重试」，而点重试它依然检测到自己 —— 死循环，装不上。
#
#  2) $INSTDIR 为空时，PowerShell 的 StartsWith('') 对每个进程都为真 —— 整机进程都被算成
#     「应用在运行」。
#
# 另外把提示做得可操作：客户端是托盘常驻的，关窗口 ≠ 退进程，得从托盘右键退出。

!include "getProcessInfo.nsh"

Var /GLOBAL wwSelfPid
Var /GLOBAL wwRunning
Var /GLOBAL wwRetry

# 查 $INSTDIR 下是否有「除安装程序自己以外」的进程在跑。结果写入 $wwRunning（0 = 有）。
!macro WW_FIND_RUNNING
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "if (@(Get-CimInstance Win32_Process | ? { $$_.Path -and $$_.ProcessId -ne $wwSelfPid -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') }).Count -gt 0) { exit 0 } else { exit 1 }"`
  Pop $wwRunning
!macroend

# 关掉 $INSTDIR 下的进程（同样排除自己）。_FORCE=1 时强杀。
!macro WW_KILL_RUNNING _FORCE
  Push $0
  ${if} ${_FORCE} == 1
    StrCpy $0 "-Force"
  ${else}
    StrCpy $0 ""
  ${endIf}
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance Win32_Process | ? { $$_.Path -and $$_.ProcessId -ne $wwSelfPid -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | % { Stop-Process -Id $$_.ProcessId $0 -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro customCheckAppRunning
  ${GetProcessInfo} 0 $wwSelfPid $1 $2 $3 $4

  # $INSTDIR 还没定 → 无从判断，直接放行（默认实现在这里会误判成「全都在运行」）
  ${if} $INSTDIR == ""
    Goto ww_done
  ${endIf}

  !insertmacro WW_FIND_RUNNING
  ${if} $wwRunning != 0
    Goto ww_done   # 没在跑，正常继续
  ${endIf}

  # 升级安装：给它一点时间自己退干净，不打扰用户
  ${if} ${isUpdated}
    Sleep 1000
  ${else}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK ww_stop
    Quit
  ${endIf}

  ww_stop:
    DetailPrint "$(appClosing)"
    !insertmacro WW_KILL_RUNNING 0
    Sleep 500

    StrCpy $wwRetry 0
    ww_loop:
      IntOp $wwRetry $wwRetry + 1
      !insertmacro WW_FIND_RUNNING
      ${if} $wwRunning != 0
        Goto ww_done   # 已经关干净
      ${endIf}

      ${if} $wwRetry < 3
        Sleep 1000
        !insertmacro WW_KILL_RUNNING 1   # 强杀
        Sleep 500
        Goto ww_loop
      ${endIf}

      # 三轮还杀不掉：多半是客户端以管理员权限运行，普通权限的安装程序无权结束它。
      # 提示里给出可操作路径：托盘右键退出（关窗口只是最小化到托盘，进程还在）。
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "无为仍在运行，无法自动关闭。$\r$\n$\r$\n请在任务栏右下角托盘图标上右键 →「退出」，$\r$\n若仍不行，在任务管理器结束 wuwei.exe，然后点「重试」。" /SD IDCANCEL IDRETRY ww_loop_reset
      Quit

    ww_loop_reset:
      StrCpy $wwRetry 0
      Goto ww_loop

  ww_done:
!macroend
