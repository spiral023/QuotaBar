$ErrorActionPreference = 'Stop'
$result = [ordered]@{ success = $false; phase = 'install'; installed = $false; updated = $false; relaunched = $false; dataRetained = $null }
$testStartedAt = Get-Date
try {
  Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier 'QuotaBarTraceStart' | Out-Null
  Register-WmiEvent -Class Win32_ProcessStopTrace -SourceIdentifier 'QuotaBarTraceStop' | Out-Null
} catch { }
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
  $initialStartedAt = $initial.StartTime
  $result.phase = 'baseline-driver'
  $driver = Start-Process -FilePath 'C:\QuotaBarBuilds\node.exe' -ArgumentList 'C:\QuotaBarBuilds\driver.cjs' -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput 'C:\QuotaBarResults\driver.log' -RedirectStandardError 'C:\QuotaBarResults\driver-error.log'
  if ($driver.ExitCode -ne 0) { throw 'Installed updater driver failed' }
  $result.phase = 'await-relaunch'
  $guestLog = Join-Path $env:USERPROFILE '.quotabar-win\quotabar.log'
  $deadline = (Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Milliseconds 1000
    # NSIS briefly removes the previous executable while replacing its files.
    $installedFile = Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue
    $version = if ($installedFile) { $installedFile.VersionInfo.ProductVersion } else { '' }
    # Renderer/GPU children can outlive the original main process during NSIS replacement.
    # Disk version plus any surviving child is not evidence of automatic relaunch.
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'QuotaBar.exe'" | Where-Object {
      $_.ExecutablePath -eq $exe -and $_.ProcessId -ne $initial.Id -and $_.CreationDate -gt $initialStartedAt -and $_.CommandLine -and $_.CommandLine -notmatch '--type='
    })
    $startupConfirmed = $false
    if (Test-Path -LiteralPath $guestLog) {
      try {
        $startupLog = Get-Content -Raw -LiteralPath $guestLog
        $newSession = $startupLog.LastIndexOf('QuotaBar startup: version=2.3.2 ')
        $startupConfirmed = $newSession -ge 0 -and $startupLog.Substring($newSession).Contains('QuotaBar started;')
      } catch { $startupConfirmed = $false }
    }
  } until (($version -like '2.3.2*' -and $running.Count -gt 0 -and $startupConfirmed -and -not (Get-Process -Id $initial.Id -ErrorAction SilentlyContinue)) -or (Get-Date) -gt $deadline)
  $result.updated = $version -like '2.3.2*'
  $result.relaunched = $running.Count -gt 0 -and $startupConfirmed -and -not (Get-Process -Id $initial.Id -ErrorAction SilentlyContinue)
  if (-not $result.updated -or -not $result.relaunched) { throw 'Update did not install and relaunch automatically' }
  @{ mainProcessIds = @($running.ProcessId); startupVersion = '2.3.2' } | ConvertTo-Json | Set-Content -LiteralPath 'C:\QuotaBarResults\relaunch.json' -Encoding utf8
  # Reopen with CDP only after observing the updater's own automatic relaunch.
  Get-Process -Name QuotaBar -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $stopDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Process -Name QuotaBar -ErrorAction SilentlyContinue) -and (Get-Date) -lt $stopDeadline) { Start-Sleep -Milliseconds 250 }
  if (Get-Process -Name QuotaBar -ErrorAction SilentlyContinue) { throw 'Previous installed instance did not stop before verification' }
  $result.phase = 'verify-updated-app'
  Start-Process -FilePath $exe -ArgumentList @('--open-window', '--remote-debugging-port=18766') -WindowStyle Hidden | Out-Null
  $verify = Start-Process -FilePath 'C:\QuotaBarBuilds\node.exe' -ArgumentList @('C:\QuotaBarBuilds\driver.cjs','--verify') -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput 'C:\QuotaBarResults\verify.log' -RedirectStandardError 'C:\QuotaBarResults\verify-error.log'
  if ($verify.ExitCode -ne 0) { throw 'Updated UI or retained data verification failed' }
  $result.dataRetained = $true
  $result.updater = Get-Content -Raw -LiteralPath 'C:\QuotaBarResults\download.json' | ConvertFrom-Json
  $result.phase = 'complete'
  $result.success = $true
} catch {
  $result.error = $_.Exception.Message
  # Only this credential-free sandbox's log is copied for diagnosis.
  $guestLog = Join-Path $env:USERPROFILE '.quotabar-win\quotabar.log'
  if (Test-Path -LiteralPath $guestLog) { Copy-Item -LiteralPath $guestLog -Destination 'C:\QuotaBarResults\guest-app.log' }
  $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'QuotaBar.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate,@{ Name = 'Role'; Expression = {
    if ($_.CommandLine -match '--type=([\w-]+)') { $Matches[1] } else { 'main' }
  } })
  ConvertTo-Json -InputObject $processes | Set-Content -LiteralPath 'C:\QuotaBarResults\guest-processes.json' -Encoding utf8
  $shell = New-Object -ComObject WScript.Shell
  $shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\QuotaBar.lnk'
  $shortcut = if (Test-Path -LiteralPath $shortcutPath) { $shell.CreateShortcut($shortcutPath) } else { $null }
  @{ explorerPresent = [bool](Get-Process -Name explorer -ErrorAction SilentlyContinue); shortcutTarget = $shortcut.TargetPath; shortcutDirectory = $shortcut.WorkingDirectory } |
    ConvertTo-Json | Set-Content -LiteralPath 'C:\QuotaBarResults\guest-shell.json' -Encoding utf8
  $appErrors = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $testStartedAt } -ErrorAction SilentlyContinue |
    Where-Object { $_.ProviderName -in @('Application Error','Windows Error Reporting') } | Select-Object TimeCreated,Id,ProviderName,Message)
  ConvertTo-Json -InputObject $appErrors -Depth 4 | Set-Content -LiteralPath 'C:\QuotaBarResults\guest-app-errors.json' -Encoding utf8
}
try {
  $trace = @(Get-Event -ErrorAction SilentlyContinue | Where-Object {
    $_.SourceIdentifier -in @('QuotaBarTraceStart','QuotaBarTraceStop') -and $_.SourceEventArgs.NewEvent.ProcessName -like 'QuotaBar*'
  } | ForEach-Object {
    $item = $_.SourceEventArgs.NewEvent
    [pscustomobject]@{ event = $_.SourceIdentifier; name = $item.ProcessName; processId = $item.ProcessID; parentProcessId = $item.ParentProcessID; exitStatus = $item.ExitStatus;
      timeUtc = [DateTime]::FromFileTimeUtc([long]$item.TIME_CREATED).ToString('o') }
  })
  ConvertTo-Json -InputObject $trace -Depth 4 | Set-Content -LiteralPath 'C:\QuotaBarResults\process-trace.json' -Encoding utf8
} catch { }
Unregister-Event -SourceIdentifier 'QuotaBarTraceStart' -ErrorAction SilentlyContinue
Unregister-Event -SourceIdentifier 'QuotaBarTraceStop' -ErrorAction SilentlyContinue
Get-Process -Name QuotaBar -ErrorAction SilentlyContinue | Stop-Process -Force
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath 'C:\QuotaBarResults\result.json' -Encoding utf8
Start-Process -FilePath 'shutdown.exe' -ArgumentList @('/s','/t','0') -WindowStyle Hidden
