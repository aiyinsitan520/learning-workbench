# 停止后台运行的学习工作台服务。只停「app\server.js」这个进程，不碰其他 Node 程序。
$port = if ($env:WORKBENCH_PORT) { $env:WORKBENCH_PORT } else { '7321' }
$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $c) { Write-Host "学习工作台没有在运行。"; exit 0 }
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
if ($p.CommandLine -match 'app[\\/]server\.js') {
  Stop-Process -Id $c.OwningProcess -Confirm:$false
  Write-Host "已停止学习工作台（PID $($c.OwningProcess)）。"
} else {
  Write-Host "端口 $port 上不是学习工作台，未处理：$($p.CommandLine)"
}
