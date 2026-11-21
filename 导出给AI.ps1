$ErrorActionPreference = 'Stop'
try {
    $node = (Get-Command node.exe -CommandType Application).Source
    $script = Join-Path $PSScriptRoot 'app\tools\export-ai.mjs'
    $out = Join-Path $PSScriptRoot 'app\data\ai-export'
    $ErrorActionPreference = 'Continue'
    $result = & $node $script --days 30 --out $out 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) { throw ($result -join [Environment]::NewLine) }
    & explorer.exe $out
} catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, '导出学习工作台数据失败', 'OK', 'Error') | Out-Null
}
