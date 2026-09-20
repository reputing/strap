/**
 * The PowerShell side of the Windows adapter.
 *
 * Spawning PowerShell costs roughly 150-300ms, so we spawn it exactly once and
 * keep it alive, speaking newline-delimited JSON over stdio. Everything the app
 * needs from Windows goes through this one process.
 *
 * Process lifetime uses a WMI event subscription rather than a polling loop in
 * our own process: the polling that does happen happens inside the WMI service
 * at a 2-second granularity, which is dramatically cheaper than shelling out to
 * `tasklist` on a timer.
 */
export const AGENT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace Blossom -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@ -ErrorAction SilentlyContinue

function Send($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Reply($id, $ok, $data, $err) {
  Send @{ type = 'reply'; id = $id; ok = $ok; data = $data; error = $err }
}

$script:watchers = @{}

function Start-ProcWatch($names) {
  $filter = ($names | ForEach-Object { "TargetInstance.Name = '$_'" }) -join ' OR '
  $createQuery = "SELECT * FROM __InstanceCreationEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_Process' AND ($filter)"
  $deleteQuery = "SELECT * FROM __InstanceDeletionEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_Process' AND ($filter)"

  Register-CimIndicationEvent -Query $createQuery -SourceIdentifier 'BlossomProcStart' -Action {
    $p = $Event.SourceEventArgs.NewEvent.TargetInstance
    $started = $null
    try { $started = [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime() } catch {}
    $ms = if ($started) { [long]([DateTimeOffset]$started).ToUnixTimeMilliseconds() } else { [long]([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() }
    $obj = @{ type='event'; event='process'; kind='started'; pid=[int]$p.ProcessId; name=$p.Name; executable=$p.ExecutablePath; startedAt=$ms }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } | Out-Null

  Register-CimIndicationEvent -Query $deleteQuery -SourceIdentifier 'BlossomProcStop' -Action {
    $p = $Event.SourceEventArgs.NewEvent.TargetInstance
    $obj = @{ type='event'; event='process'; kind='stopped'; pid=[int]$p.ProcessId; name=$p.Name }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } | Out-Null
}

function Get-Procs($names) {
  $out = @()
  foreach ($n in $names) {
    $base = [IO.Path]::GetFileNameWithoutExtension($n)
    foreach ($p in (Get-Process -Name $base -ErrorAction SilentlyContinue)) {
      $exe = $null
      try { $exe = $p.MainModule.FileName } catch {}
      $out += @{
        pid = $p.Id
        name = $n
        executable = $exe
        startedAt = [long]([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
      }
    }
  }
  return ,$out
}

function Get-Counters($procId) {
  $p = Get-Process -Id $procId -ErrorAction Stop
  return @{
    pid = $p.Id
    cpuTimeMs = [long]$p.TotalProcessorTime.TotalMilliseconds
    memoryBytes = [long]$p.WorkingSet64
    startedAt = [long]([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  }
}

function Get-Hardware {
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  $gpus = @()
  foreach ($g in (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)) {
    $gpus += @{ model = $g.Name; vendor = $g.AdapterCompatibility; memoryBytes = [long]$g.AdapterRAM }
  }
  return @{
    cpuModel = $cpu.Name
    cpuCores = [int]$cpu.NumberOfCores
    cpuThreads = [int]$cpu.NumberOfLogicalProcessors
    cpuMhz = [int]$cpu.MaxClockSpeed
    memoryTotal = [long]$cs.TotalPhysicalMemory
    memoryFree = [long]($os.FreePhysicalMemory * 1024)
    osName = $os.Caption
    osVersion = $os.Version
    osBuild = $os.BuildNumber
    osArch = $os.OSArchitecture
    gpus = ,$gpus
  }
}

function Get-Bounds($procId) {
  $p = Get-Process -Id $procId -ErrorAction Stop
  $h = $p.MainWindowHandle
  if ($h -eq 0) { return $null }
  $r = New-Object Blossom.Win+RECT
  if (-not [Blossom.Win]::GetWindowRect($h, [ref]$r)) { return $null }
  return @{ x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}

function Test-Foreground($procId) {
  $h = [Blossom.Win]::GetForegroundWindow()
  $owner = 0
  [Blossom.Win]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
  return ($owner -eq $procId)
}

Send @{ type = 'ready'; pid = $PID }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  try {
    switch ($req.op) {
      'ping'        { Reply $req.id $true @{ pong = $true } $null }
      'list'        { Reply $req.id $true (Get-Procs $req.names) $null }
      'watch'       { Start-ProcWatch $req.names; Reply $req.id $true @{ watching = $true } $null }
      'sample'      { Reply $req.id $true (Get-Counters ([int]$req.pid)) $null }
      'hardware'    { Reply $req.id $true (Get-Hardware) $null }
      'bounds'      { Reply $req.id $true (Get-Bounds ([int]$req.pid)) $null }
      'foreground'  { Reply $req.id $true @{ foreground = (Test-Foreground ([int]$req.pid)) } $null }
      'priority'    {
        $p = Get-Process -Id ([int]$req.pid) -ErrorAction Stop
        $p.PriorityClass = [Diagnostics.ProcessPriorityClass]$req.value
        Reply $req.id $true @{ set = $true } $null
      }
      'affinity'    {
        $p = Get-Process -Id ([int]$req.pid) -ErrorAction Stop
        $p.ProcessorAffinity = [IntPtr][long]$req.value
        Reply $req.id $true @{ set = $true } $null
      }
      'kill'        { Stop-Process -Id ([int]$req.pid) -ErrorAction Stop; Reply $req.id $true @{ killed = $true } $null }
      'reg-set'     {
        if ($null -eq $req.value) {
          Remove-Item -Path $req.path -Recurse -Force -ErrorAction SilentlyContinue
        } else {
          New-Item -Path $req.path -Force | Out-Null
          Set-ItemProperty -Path $req.path -Name $req.name -Value $req.value
        }
        Reply $req.id $true @{ set = $true } $null
      }
      'reg-get'     {
        $v = $null
        try { $v = (Get-ItemProperty -Path $req.path -Name $req.name -ErrorAction Stop).$($req.name) } catch {}
        Reply $req.id $true @{ value = $v } $null
      }
      'protocol-set' {
        $root = "HKCU:\Software\Classes\$($req.protocol)"
        if ($null -eq $req.command) {
          Remove-Item -Path $root -Recurse -Force -ErrorAction SilentlyContinue
        } else {
          New-Item -Path $root -Force | Out-Null
          Set-ItemProperty -Path $root -Name '(default)' -Value "URL:$($req.protocol) Protocol"
          Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''
          New-Item -Path "$root\shell\open\command" -Force | Out-Null
          Set-ItemProperty -Path "$root\shell\open\command" -Name '(default)' -Value $req.command
        }
        Reply $req.id $true @{ set = $true } $null
      }
      'protocol-get' {
        $v = $null
        try { $v = (Get-ItemProperty -Path "HKCU:\Software\Classes\$($req.protocol)\shell\open\command" -Name '(default)' -ErrorAction Stop).'(default)' } catch {}
        Reply $req.id $true @{ value = $v } $null
      }
      default       { Reply $req.id $false $null "unknown op: $($req.op)" }
    }
  } catch {
    Reply $req.id $false $null $_.Exception.Message
  }
}
`;
