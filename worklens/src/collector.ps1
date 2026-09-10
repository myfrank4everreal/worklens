Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ActiveWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
}
"@

$handle = [ActiveWindow]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 1024
[void][ActiveWindow]::GetWindowText($handle, $builder, $builder.Capacity)
$processIdValue = 0
[void][ActiveWindow]::GetWindowThreadProcessId($handle, [ref]$processIdValue)
$process = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue

# Idle time since the last keyboard/mouse input, independent of which window is foregrounded —
# a window left open while you're away from the keyboard should not count as focused work.
# (GetTickCount wraps after ~49.7 days of uptime; on that rare boundary this can briefly read a
# large idle value instead of a small one, which only errs toward under-counting active time.)
$lastInput = New-Object ActiveWindow+LASTINPUTINFO
$lastInput.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][ActiveWindow+LASTINPUTINFO])
[void][ActiveWindow]::GetLastInputInfo([ref]$lastInput)
$idleMs = [int64][ActiveWindow]::GetTickCount() - [int64]$lastInput.dwTime
if ($idleMs -lt 0) { $idleMs = 0 }
$idleSeconds = [math]::Round($idleMs / 1000)

[pscustomobject]@{
  app = if ($process) { $process.ProcessName } else { "Unknown" }
  title = $builder.ToString()
  idleSeconds = $idleSeconds
} | ConvertTo-Json -Compress
