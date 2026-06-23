# Register megz WeChat Bridge as a Windows startup task
# Run once: powershell -ExecutionPolicy Bypass -File bridge\scripts\install-startup.ps1

$MEGZ_ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "bridge/index.js" -WorkingDirectory $MEGZ_ROOT
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "MegzWeChatBridge" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Auto-start megz WeChat Bridge on boot" -Force

Write-Host "=== Megz WeChat Bridge installed ==="
Write-Host "Task: MegzWeChatBridge"
Write-Host "Auto-starts on every boot."
Write-Host ""
Write-Host "Start now: Start-ScheduledTask -TaskName MegzWeChatBridge"
Write-Host "Stop:      Stop-ScheduledTask -TaskName MegzWeChatBridge"
Write-Host "Uninstall: Unregister-ScheduledTask -TaskName MegzWeChatBridge -Confirm:$false"
