# Registers the Pitch Prophet daily run in Windows Task Scheduler (current user, no admin needed).
#   powershell -ExecutionPolicy Bypass -File scripts\sports-task.ps1 -Start "11:00"
# Runs while this user is logged in, wakes the laptop from sleep where Windows allows it, and catches
# up at next start if the time was missed. Remove with: Unregister-ScheduledTask "Pitch Prophet daily"
param(
  [string]$Start = "11:00",
  [string]$Name = "Pitch Prophet daily",
  [string]$RunArgs = "",
  [switch]$Once
)
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$command = "& '$node' --env-file-if-exists=.env scripts/sports-daily.mjs $RunArgs; exit `$LASTEXITCODE"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $root `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$command`""
$when = [datetime]::Parse($Start)
$trigger = if ($Once) { New-ScheduledTaskTrigger -Once -At $when } else { New-ScheduledTaskTrigger -Daily -At $when }
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Get-ScheduledTaskInfo -TaskName $Name | Select-Object TaskName, NextRunTime
