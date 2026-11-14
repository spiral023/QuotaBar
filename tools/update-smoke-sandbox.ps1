$ErrorActionPreference = 'Stop'
$result = [ordered]@{ success = $false; installed = $false; updated = $false; relaunched = $false; dataRetained = $false }
try {
  $installDir = 'C:\QuotaBarUpdateTest'
  $exe = Join-Path $installDir 'QuotaBar.exe'
  $setup = Start-Process -FilePath 'C:\QuotaBarBuilds\old\QuotaBar-2.3.1-setup.exe' -ArgumentList @('/S', '/D=C:\QuotaBarUpdateTest') -Wait -PassThru -WindowStyle Hidden
  if ($setup.ExitCode -notin @(0,3010)) { throw 'Baseline installer failed' }
  if ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -notlike '2.3.1*') { throw 'Wrong baseline version' }
  $result.installed = $true
  Get-Process -Name QuotaBar -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $appData = Join-Path $env:USERPROFILE '.quotabar-win'
  New-Item -ItemType Directory -Force -Path $appData | Out-Null
  # The driver seeds only synthetic portable events, without provider credentials.
  & 'C:\QuotaBarBuilds\node.exe' 'C:\QuotaBarBuilds\driver.cjs' '--seed'
  if ($LASTEXITCODE -ne 0) { throw 'Synthetic data setup failed' }
  $initial = Start-Process -FilePath $exe -ArgumentList @('--open-window', '--remote-debugging-port=18766') -PassThru -WindowStyle Hidden
  $driver = Start-Process -FilePath 'C:\QuotaBarBuilds\node.exe' -ArgumentList 'C:\QuotaBarBuilds\driver.cjs' -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput 'C:\QuotaBarResults\driver.log' -RedirectStandardError 'C:\QuotaBarResults\driver-error.log'
  if ($driver.ExitCode -ne 0) { throw 'Installed updater driver failed' }
  $deadline = (Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Milliseconds 1000
    # NSIS briefly removes the previous executable while replacing its files.
    $installedFile = Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue
    $version = if ($installedFile) { $installedFile.VersionInfo.ProductVersion } else { '' }
    $running = @(Get-Process -Name QuotaBar -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe -and $_.Id -ne $initial.Id })
  } until (($version -like '2.3.2*' -and $running.Count -gt 0 -and -not (Get-Process -Id $initial.Id -ErrorAction SilentlyContinue)) -or (Get-Date) -gt $deadline)
  $result.updated = $version -like '2.3.2*'
  $result.relaunched = $running.Count -gt 0 -and -not (Get-Process -Id $initial.Id -ErrorAction SilentlyContinue)
  if (-not $result.updated -or -not $result.relaunched) { throw 'Update did not install and relaunch automatically' }
  # Reopen with CDP only after observing the updater's own automatic relaunch.
  Get-Process -Name QuotaBar -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Start-Process -FilePath $exe -ArgumentList @('--open-window', '--remote-debugging-port=18766') -WindowStyle Hidden | Out-Null
  $verify = Start-Process -FilePath 'C:\QuotaBarBuilds\node.exe' -ArgumentList @('C:\QuotaBarBuilds\driver.cjs','--verify') -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput 'C:\QuotaBarResults\verify.log' -RedirectStandardError 'C:\QuotaBarResults\verify-error.log'
  if ($verify.ExitCode -ne 0) { throw 'Updated UI or retained data verification failed' }
  $result.dataRetained = $true
  $result.updater = Get-Content -Raw -LiteralPath 'C:\QuotaBarResults\download.json' | ConvertFrom-Json
  $result.success = $true
} catch {
  $result.error = $_.Exception.Message
  # Only this credential-free sandbox's log is copied for diagnosis.
  $guestLog = Join-Path $env:USERPROFILE '.quotabar-win\quotabar.log'
  if (Test-Path -LiteralPath $guestLog) { Copy-Item -LiteralPath $guestLog -Destination 'C:\QuotaBarResults\guest-app.log' }
  Get-Process -Name QuotaBar -ErrorAction SilentlyContinue | Select-Object Id,Path,StartTime | ConvertTo-Json | Set-Content -LiteralPath 'C:\QuotaBarResults\guest-processes.json' -Encoding utf8
}
Get-Process -Name QuotaBar -ErrorAction SilentlyContinue | Stop-Process -Force
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath 'C:\QuotaBarResults\result.json' -Encoding utf8
Start-Process -FilePath 'shutdown.exe' -ArgumentList @('/s','/t','0') -WindowStyle Hidden
