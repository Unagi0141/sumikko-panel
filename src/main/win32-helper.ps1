# Timeline Dock の Win32 ヘルパー。
#
# Electron から直接 Win32 API を呼ぶにはネイティブモジュールのビルドが要るため、
# この PowerShell を常駐の子プロセスとして起動し、標準入出力で行単位の JSON を
# やりとりする。P/Invoke の定義（Add-Type）は起動時に一度だけ行う。
#
#   受け取る:  {"id":1,"cmd":"appbar_setpos","hwnd":123,"edge":"right", ...}
#   返す:      {"id":1,"ok":true,"result":{...}}
#   自発通知:  {"event":"fullscreen","value":true}
#
# 親プロセスが死んで標準入力が閉じたら、AppBar の登録を解除してから終了する。
# （解除し損ねると、画面の作業領域が狭いままになるため）

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TlDockNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct APPBARDATA {
    public uint cbSize;
    public IntPtr hWnd;
    public uint uCallbackMessage;
    public uint uEdge;
    public RECT rc;
    public int lParam;
  }

  [DllImport("shell32.dll", CallingConvention = CallingConvention.StdCall)]
  public static extern UIntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);

  [DllImport("shell32.dll")]
  public static extern int SHQueryUserNotificationState(out int state);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);

  [DllImport("user32.dll")]
  public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);

  [DllImport("user32.dll")]
  public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

  public static string ForegroundClassName() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
'@

# --- 定数 -------------------------------------------------------------------
$ABM_NEW = 0x0
$ABM_REMOVE = 0x1
$ABM_QUERYPOS = 0x2
$ABM_SETPOS = 0x3
$ABE_LEFT = 0
$ABE_RIGHT = 2

# 全画面アプリ判定に使う SHQueryUserNotificationState の値。
# QUNS_BUSY(2) は全画面以外の「取り込み中」でも立つことがあり誤検知するので使わない。
$QUNS_RUNNING_D3D_FULL_SCREEN = 3
$QUNS_PRESENTATION_MODE = 4

# デスクトップやタスクバー自身は「全画面アプリ」とみなさない
$ShellClasses = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Windows.UI.Core.CoreWindow')

$script:RegisteredHwnd = [IntPtr]::Zero

function New-AppBarData([IntPtr]$hwnd) {
  $d = New-Object TlDockNative+APPBARDATA
  $d.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][TlDockNative+APPBARDATA])
  $d.hWnd = $hwnd
  # 実際には受け取らないが、ABM_NEW にはコールバックメッセージ ID が必要
  $d.uCallbackMessage = 0x0400 + 0x5432
  return $d
}

function Write-Line([object]$obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

function Register-AppBar([IntPtr]$hwnd) {
  if ($script:RegisteredHwnd -ne [IntPtr]::Zero) { return $true }
  $d = New-AppBarData $hwnd
  $r = [TlDockNative]::SHAppBarMessage($ABM_NEW, [ref]$d)
  if ($r -ne [UIntPtr]::Zero) { $script:RegisteredHwnd = $hwnd; return $true }
  return $false
}

function Unregister-AppBar {
  if ($script:RegisteredHwnd -eq [IntPtr]::Zero) { return }
  $d = New-AppBarData $script:RegisteredHwnd
  [void][TlDockNative]::SHAppBarMessage($ABM_REMOVE, [ref]$d)
  $script:RegisteredHwnd = [IntPtr]::Zero
}

# 予約したい矩形をシェルに問い合わせ、認められた位置にウインドウを移動する。
function Set-AppBarPos([IntPtr]$hwnd, [string]$edge, [int]$x, [int]$y, [int]$w, [int]$h, [int]$thickness) {
  $d = New-AppBarData $hwnd
  $d.uEdge = if ($edge -eq 'left') { $ABE_LEFT } else { $ABE_RIGHT }

  # RECT は構造体（値型）なので $d.rc.left = ... と書いてもコピーを書き換えるだけで
  # 元には反映されない。必ず RECT を組み立ててから $d.rc ごと差し替える。
  $rc = New-Object TlDockNative+RECT
  $rc.left = $x
  $rc.top = $y
  $rc.right = $x + $w
  $rc.bottom = $y + $h
  $d.rc = $rc

  [void][TlDockNative]::SHAppBarMessage($ABM_QUERYPOS, [ref]$d)

  # QUERYPOS は「モニタのうち使ってよい範囲」を返す（タスクバーなど既存の
  # AppBar のぶんが差し引かれている）。そこから希望の厚みだけを端に切り出す。
  $rc = $d.rc
  if ($d.uEdge -eq $ABE_RIGHT) { $rc.left = $rc.right - $thickness } else { $rc.right = $rc.left + $thickness }
  $d.rc = $rc

  [void][TlDockNative]::SHAppBarMessage($ABM_SETPOS, [ref]$d)

  $rc = $d.rc
  [void][TlDockNative]::MoveWindow($hwnd, $rc.left, $rc.top, ($rc.right - $rc.left), ($rc.bottom - $rc.top), $true)

  return @{
    x = $rc.left
    y = $rc.top
    width = ($rc.right - $rc.left)
    height = ($rc.bottom - $rc.top)
  }
}

function Get-ForegroundMonitorRect {
  # 前面ウインドウが載っているモニタの範囲を返す。分からなければ $null。
  $h = [TlDockNative]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return $null }

  $mon = [TlDockNative]::MonitorFromWindow($h, 2)
  if ($mon -eq [IntPtr]::Zero) { return $null }

  $mi = New-Object TlDockNative+MONITORINFOEX
  $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][TlDockNative+MONITORINFOEX])
  if (-not [TlDockNative]::GetMonitorInfo($mon, [ref]$mi)) { return $null }

  $m = $mi.rcMonitor
  return @{
    x = $m.left
    y = $m.top
    width = ($m.right - $m.left)
    height = ($m.bottom - $m.top)
  }
}

function Get-FullscreenInfo {
  # 「全画面かどうか」だけでなく「どのモニタでか」も返す。
  # 別のモニタで全画面になっただけなら、ドックは引っ込む必要がないため。
  $none = @{ value = $false; monitor = $null }

  $state = 0
  try { [void][TlDockNative]::SHQueryUserNotificationState([ref]$state) } catch { $state = 0 }
  if ($state -eq $QUNS_RUNNING_D3D_FULL_SCREEN -or $state -eq $QUNS_PRESENTATION_MODE) {
    # 排他全画面のゲームでも、前面ウインドウはそのゲームなのでモニタは取れる。
    return @{ value = $true; monitor = (Get-ForegroundMonitorRect) }
  }

  # ボーダーレス全画面はうえで拾えないことがあるので、
  # 前面ウインドウがモニタ全体を覆っているかも見る。
  $h = [TlDockNative]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return $none }
  if ($h -eq $script:RegisteredHwnd) { return $none }

  $cls = [TlDockNative]::ForegroundClassName()
  if ($ShellClasses -contains $cls) { return $none }

  $r = New-Object TlDockNative+RECT
  if (-not [TlDockNative]::GetWindowRect($h, [ref]$r)) { return $none }

  $mon = [TlDockNative]::MonitorFromWindow($h, 2)
  $mi = New-Object TlDockNative+MONITORINFOEX
  $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][TlDockNative+MONITORINFOEX])
  if (-not [TlDockNative]::GetMonitorInfo($mon, [ref]$mi)) { return $none }

  $covers = ($r.left -le $mi.rcMonitor.left -and $r.top -le $mi.rcMonitor.top -and
             $r.right -ge $mi.rcMonitor.right -and $r.bottom -ge $mi.rcMonitor.bottom)
  if (-not $covers) { return $none }

  $m = $mi.rcMonitor
  return @{
    value = $true
    monitor = @{
      x = $m.left
      y = $m.top
      width = ($m.right - $m.left)
      height = ($m.bottom - $m.top)
    }
  }
}

# --- メインループ -----------------------------------------------------------
#
# 純粋な要求 / 応答に徹し、ReadLine で待ち受ける。
# （パイプ相手の [Console]::In.Peek() は当てにならないため、自前のポーリングはしない。
#   全画面の監視は Node 側が定期的に 'fullscreen' を投げてくる。）
# 親が死ぬと標準入力が閉じ、ReadLine が $null を返してループを抜け、AppBar を解除する。

Write-Line @{ event = 'ready' }

try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { $req = $null }
    if ($null -eq $req) { continue }

    $res = @{ id = $req.id; ok = $true }
    try {
      switch ($req.cmd) {
        'appbar_new'    { $res.result = (Register-AppBar ([IntPtr][int64]$req.hwnd)) }
        'appbar_setpos' {
          [void](Register-AppBar ([IntPtr][int64]$req.hwnd))
          $res.result = (Set-AppBarPos ([IntPtr][int64]$req.hwnd) $req.edge $req.x $req.y $req.w $req.h $req.thickness)
        }
        'appbar_remove' { Unregister-AppBar; $res.result = $true }
        'fullscreen'    { $res.result = (Get-FullscreenInfo) }
        'ping'          { $res.result = 'pong' }
        default         { $res.ok = $false; $res.error = "unknown cmd: $($req.cmd)" }
      }
    } catch {
      $res.ok = $false
      $res.error = $_.Exception.Message
    }
    Write-Line $res
  }
} finally {
  Unregister-AppBar
}
