param([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [switch]$RightClick, [switch]$Click)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OrbMouse {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[OrbMouse]::SetProcessDPIAware() | Out-Null
[OrbMouse]::SetCursorPos($FromX, $FromY) | Out-Null
Start-Sleep -Milliseconds 200
if ($RightClick) {
  [OrbMouse]::mouse_event(8,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  [OrbMouse]::mouse_event(16,0,0,0,[UIntPtr]::Zero)
  exit
}
[OrbMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
if ($Click) {
  [OrbMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  exit
}
try {
  foreach ($step in 1..28) {
    [OrbMouse]::SetCursorPos(($FromX + [int](($ToX-$FromX)*$step/28)), ($FromY + [int](($ToY-$FromY)*$step/28))) | Out-Null
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 250
} finally {
  [OrbMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
