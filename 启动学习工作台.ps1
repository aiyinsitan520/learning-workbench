# 一键打开学习工作台：服务没在跑就在后台启动（不留黑窗口），然后用 Chrome 打开页面。
# 双击桌面「学习工作台」快捷方式即可；关掉浏览器不会停服务。要停服务运行同目录的「停止学习工作台.ps1」。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:WORKBENCH_PORT) { $env:WORKBENCH_PORT } else { '7321' }
$url = "http://127.0.0.1:$port/"
$log = Join-Path $root 'app\data\server.log'

function Test-Workbench {
  try {
    $r = Invoke-RestMethod "${url}api/health" -TimeoutSec 2
    return [bool]$r.ok
  } catch { return $false }
}

function Show-Error($text) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($text, '学习工作台', 'OK', 'Error') | Out-Null
}

# 用 Chrome 的应用模式打开：独立窗口、没有地址栏和标签页，任务栏显示白猫图标。
# 已经开着一个窗口时把它带到前面，不重复开。
function Open-Page {
  Add-Type -Namespace LS -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
'@ -ErrorAction SilentlyContinue
  $win = Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq '学习工作台' } | Select-Object -First 1
  if ($win) {
    [LS.Win]::ShowWindow($win.MainWindowHandle, 9) | Out-Null
    [LS.Win]::SetForegroundWindow($win.MainWindowHandle) | Out-Null
    return
  }
  try { Start-Process 'chrome.exe' @("--app=$url", '--window-size=1440,900') }
  catch { Start-Process $url }
}

if (Test-Workbench) { Open-Page; exit 0 }

# 端口被别的程序占着就不硬启动
$busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($busy) {
  $who = (Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.OwningProcess)").CommandLine
  Show-Error "端口 $port 已被其他程序占用：`n$who"
  exit 1
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Show-Error '没有找到 Node.js，请安装 22 或更新版本：https://nodejs.org'; exit 1 }
$major = [int]((& $node -p 'process.versions.node').Split('.')[0])
if ($major -lt 22) { Show-Error "Node.js 版本过低（需要 22 或更新）。"; exit 1 }

New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
if (-not (Test-Path (Join-Path $root 'app\data\workbench.db'))) {
  & $node (Join-Path $root 'app\seed.js') *> $null
}

$env:PORT = $port
Start-Process -FilePath $node -ArgumentList 'app\server.js' -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"

for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-Workbench) { Open-Page; exit 0 }
}
Show-Error "学习工作台没能启动，请查看日志：`n$log.err"
exit 1
