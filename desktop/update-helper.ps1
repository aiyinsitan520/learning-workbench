# Learning Workbench update helper (Windows ZIP edition). Started by desktop/update-install.mjs.
# Waits for the app to exit, keeps the old folder as "<AppDir>.previous", moves the verified
# staging folder into place and starts the new version. On failure it restores the old folder
# and starts it again. Kept ASCII-only so Windows PowerShell 5.1 reads it without a BOM.
param(
  [Parameter(Mandatory = $true)][int]$WaitPid,
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$Staging,
  [Parameter(Mandatory = $true)][string]$ExeName,
  [Parameter(Mandatory = $true)][string]$Log,
  [string]$ArgsB64 = ''
)
$ErrorActionPreference = 'Stop'

# Original launch arguments (base64 of a JSON string array), quoted for Start-Process.
$launchArgs = @()
if ($ArgsB64) {
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64))
  # PowerShell 5.1 emits a JSON array as one pipeline object; assign first so foreach enumerates it.
  $parsed = ConvertFrom-Json $decoded
  foreach ($a in $parsed) {
    if ($a -match '[\s"]') { $launchArgs += '"' + ($a -replace '"', '\"') + '"' } else { $launchArgs += $a }
  }
}

function Start-App([string]$Exe, [string]$Dir) {
  if ($launchArgs.Count) { Start-Process -FilePath $Exe -WorkingDirectory $Dir -ArgumentList $launchArgs }
  else { Start-Process -FilePath $Exe -WorkingDirectory $Dir }
}

function Write-Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $Log -Value $line -Encoding UTF8 } catch { }
}

function Move-WithRetry([string]$From, [string]$ToLeaf) {
  for ($i = 1; $i -le 40; $i++) {
    try { Rename-Item -LiteralPath $From -NewName $ToLeaf; return }
    catch {
      if ($i -eq 40) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

$leaf = Split-Path -Leaf $AppDir
$previous = "$AppDir.previous"
$swapped = $false
try {
  Write-Log "update: waiting for process $WaitPid to exit"
  $proc = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
  if ($proc -and -not $proc.WaitForExit(90000)) { throw "the app did not exit within 90 seconds" }
  Start-Sleep -Milliseconds 800

  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
  # Renderer/GPU child processes may hold files for a moment after the main process exits.
  Move-WithRetry $AppDir (Split-Path -Leaf $previous)
  try {
    Move-WithRetry $Staging $leaf
    $swapped = $true
  } catch {
    Move-WithRetry $previous $leaf
    throw
  }
  Write-Log "update: installed new version into $AppDir (old version kept in $previous)"
  Start-App (Join-Path $AppDir $ExeName) $AppDir
  Write-Log "update: started new version"
} catch {
  Write-Log ("update: FAILED - " + $_.Exception.Message)
  if (-not (Test-Path -LiteralPath $AppDir) -and (Test-Path -LiteralPath $previous)) {
    try { Move-WithRetry $previous $leaf; Write-Log "update: restored previous version" } catch { Write-Log "update: could not restore previous version" }
  }
  $exe = Join-Path $AppDir $ExeName
  if (Test-Path -LiteralPath $exe) {
    Start-App $exe $AppDir
    Write-Log "update: restarted the app after failure (swapped=$swapped)"
  }
  exit 1
}
