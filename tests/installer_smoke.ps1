$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$qaRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot '.design-qa'))
$installPath = [IO.Path]::GetFullPath((Join-Path $qaRoot 'install-smoke'))
if (-not $installPath.StartsWith($qaRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid install test target' }
if ((Test-Path -LiteralPath (Join-Path $installPath 'relay.exe')) -and -not (Test-Path -LiteralPath (Join-Path $qaRoot 'installer-process-results.json'))) { throw 'An unrecognized install smoke directory already exists' }
$config = Get-Content -LiteralPath (Join-Path $taskRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$bundlePath = Join-Path $taskRoot ('src-tauri\target\release\bundle\nsis\' + $config.productName + '_' + $config.version + '_x64-setup.exe')
$registration = @(
    @{ Path='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Relay'; Native='HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Relay'; File='uninstall-registration.reg' },
    @{ Path='HKCU:\Software\Relay\Relay'; Native='HKCU\Software\Relay\Relay'; File='product-registration.reg' }
)
$backups = Join-Path $qaRoot 'registry-backup'
New-Item -ItemType Directory -Path $backups -Force | Out-Null
foreach ($entry in $registration) {
    $entry.Existed = Test-Path -LiteralPath $entry.Path
    if ($entry.Existed) {
        & reg.exe export $entry.Native (Join-Path $backups $entry.File) /y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot back up installation registration' }
    }
}
$installedProcess = $null
$smokeResults = [Collections.Generic.List[object]]::new()
function Check-Smoke($name, $ok) {
    $smokeResults.Add(@{ name=$name; ok=[bool]$ok })
    Write-Output "$name : $ok"
    if (-not $ok) { throw $name }
}
try {
    # The existing D:\Relay registration is restored in finally. No existing
    # installation, shortcut or user data is used by this test.
    foreach ($entry in $registration) { if ($entry.Existed) { Remove-Item -LiteralPath $entry.Path -Recurse -Force } }
    $installerProcess = Start-Process -FilePath $bundlePath -ArgumentList @('/S','/NS',("/D="+$installPath)) -WindowStyle Hidden -PassThru
    if (-not $installerProcess.WaitForExit(60000)) { throw 'Installer timed out' }
    Check-Smoke '安装器退出成功' ($installerProcess.ExitCode -eq 0)
    $installedExe = Join-Path $installPath 'relay.exe'
    Check-Smoke '安装创建主程序与卸载器' ((Test-Path -LiteralPath $installedExe) -and (Test-Path -LiteralPath (Join-Path $installPath 'uninstall.exe')))
    $env:RELAY_SMOKE_INSTALLED_EXE=$installedExe
    $env:RELAY_SMOKE_BUILD_EXE=Join-Path $taskRoot 'src-tauri\target\release\relay.exe'
    # Tauri patches only its bundle-type marker inside the NSIS payload, then
    # restores the unbundled executable. Verify every other byte is identical.
    # Resolve the interpreter rather than hardcoding one machine's install path:
    # RELAY_PYTHON wins, otherwise whatever `python` is on PATH.
    $pythonExe = if ($env:RELAY_PYTHON) { $env:RELAY_PYTHON } else { (Get-Command python -ErrorAction SilentlyContinue).Source }
    if (-not $pythonExe) { throw 'python not found on PATH; set RELAY_PYTHON to your interpreter' }
    & $pythonExe -c "import os;from pathlib import Path;a=Path(os.environ['RELAY_SMOKE_INSTALLED_EXE']).read_bytes();b=Path(os.environ['RELAY_SMOKE_BUILD_EXE']).read_bytes();assert a.replace(b'__TAURI_BUNDLE_TYPE_VAR_NSS',b'__TAURI_BUNDLE_TYPE_VAR_UNK')==b"
    Check-Smoke '安装主程序与构建一致（仅 NSIS 类型标记）' ($LASTEXITCODE -eq 0)
    $env:RELAY_DATA=Join-Path $installPath 'data'
    $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $qaRoot 'install-webview'
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9226 --remote-allow-origins=*'
    $installedProcess = Start-Process -FilePath $installedExe -WorkingDirectory $installPath -WindowStyle Hidden -PassThru
    $ready = $false
    for ($i=0; $i -lt 60; $i++) {
        try { $pages=Invoke-RestMethod 'http://127.0.0.1:9226/json/list' -TimeoutSec 1; if ($pages.Count) { $ready=$true;break } } catch {}
        Start-Sleep -Milliseconds 300
    }
    Check-Smoke '安装程序可启动' $ready
    Push-Location $taskRoot
    try { node tests/installer_smoke.cjs; if ($LASTEXITCODE -ne 0) { throw 'Installed app UI verification failed' } }
    finally { Pop-Location }
    Stop-Process -Id $installedProcess.Id
    $installedProcess.WaitForExit(20000) | Out-Null
    $uninstallerProcess = Start-Process -FilePath (Join-Path $installPath 'uninstall.exe') -ArgumentList @('/S','/UPDATE') -WindowStyle Hidden -PassThru
    if (-not $uninstallerProcess.WaitForExit(60000)) { throw 'Uninstaller timed out' }
    for ($i=0; $i -lt 50 -and (Test-Path -LiteralPath $installedExe); $i++) { Start-Sleep -Milliseconds 200 }
    Check-Smoke '卸载移除程序文件' (-not (Test-Path -LiteralPath $installedExe))
    $saved=Get-Content -LiteralPath (Join-Path $installPath 'data\settings.json') -Raw | ConvertFrom-Json
    Check-Smoke '卸载保留工作区数据' ([bool]($saved.globals | Where-Object { $_.key -eq 'installerMarker' }))
} finally {
    if ($installedProcess -and -not $installedProcess.HasExited) { Stop-Process -Id $installedProcess.Id -ErrorAction SilentlyContinue }
    foreach ($entry in $registration) {
        if (Test-Path -LiteralPath $entry.Path) { Remove-Item -LiteralPath $entry.Path -Recurse -Force }
        if ($entry.Existed) {
            & reg.exe import (Join-Path $backups $entry.File) | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Cannot restore original installation registration' }
        }
    }
    $smokeResults | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $qaRoot 'installer-process-results.json') -Encoding utf8
}
