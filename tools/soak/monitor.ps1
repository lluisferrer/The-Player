# Monitor de la prova de càrrega ("soak test") d'ezyPlayer a Windows.
#
# Cada -IntervalSec segons afegeix una fila al CSV amb: memòria (working set i
# privada) i CPU d'ezyplayer.exe i de TOTS els seus processos WebView2
# (msedgewebview2.exe descendents), handles, fils, i quants avisos/errors nous
# han aparegut al log de l'app. Acaba quan passen -Hours o quan ezyplayer es tanca.
#
# Ús:  powershell -ExecutionPolicy Bypass -File tools\soak\monitor.ps1 -Out soak.csv -Hours 6
#
# Què mirar després: la memòria privada ha de quedar PLANA (una rampa sostinguda
# = fuita), la CPU estable, i cap error nou al log.
param(
  [string]$Out = "soak.csv",
  [double]$Hours = 6,
  [int]$IntervalSec = 60
)

# Decimals amb punt (el CSV no pot dependre de la configuració regional).
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture

$log = Join-Path $env:LOCALAPPDATA "app.ezyrider.ezyplayer\logs\ezyplayer.log"
$end = (Get-Date).AddHours($Hours)

# Tots els descendents (qualsevol profunditat) d'un procés, via Win32_Process.
function Get-Descendants([int]$rootId) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $ids = New-Object System.Collections.Generic.List[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  $queue.Enqueue($rootId)
  while ($queue.Count -gt 0) {
    $p = $queue.Dequeue()
    foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) {
      $ids.Add([int]$c.ProcessId); $queue.Enqueue([int]$c.ProcessId)
    }
  }
  return ,$ids
}

# CPU (% d'un nucli) d'un procés des de l'últim mostreig.
$script:prevCpu = @{}
function Get-CpuPct($p, [double]$dt) {
  [double]$t = $p.TotalProcessorTime.TotalSeconds
  [int]$k = $p.Id
  [double]$d = 0
  if ($script:prevCpu.ContainsKey($k) -and $dt -gt 0) { $d = ($t - [double]$script:prevCpu[$k]) / $dt * 100 }
  $script:prevCpu[$k] = $t
  return $d
}

# Nombre de línies d'un nivell ("WARN"/"ERROR") al log de l'app.
function Get-LogCount([string]$level) {
  if (-not (Test-Path $log)) { return 0 }
  return [int]@(Select-String -Path $log -Pattern "\]\[$level\]").Count
}

$app = Get-Process ezyplayer -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
if (-not $app) { Write-Error "ezyplayer.exe no s'està executant"; exit 1 }
$appId = $app.Id

[int]$warn0 = Get-LogCount "WARN"
[int]$err0 = Get-LogCount "ERROR"
"time,elapsed_min,app_ws_mb,app_priv_mb,app_cpu_pct,app_handles,app_threads,wv_count,wv_ws_mb,wv_priv_mb,wv_cpu_pct,new_warn,new_error" | Out-File $Out -Encoding utf8

$prevT = Get-Date
$start = Get-Date
while ((Get-Date) -lt $end) {
  $app = Get-Process -Id $appId -ErrorAction SilentlyContinue
  if (-not $app) { "# ezyplayer s'ha tancat a $(Get-Date -Format s)" | Out-File $Out -Append -Encoding utf8; break }
  $now = Get-Date
  [double]$dt = ($now - $prevT).TotalSeconds
  $prevT = $now
  $wv = @(Get-Descendants $appId | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_ })
  [double]$appCpu = Get-CpuPct $app $dt
  [double]$wvCpu = 0
  [double]$wvWs = 0
  [double]$wvPriv = 0
  foreach ($p in $wv) {
    $wvCpu += [double](Get-CpuPct $p $dt)
    $wvWs += [double]$p.WorkingSet64
    $wvPriv += [double]$p.PrivateMemorySize64
  }
  [int]$newWarn = (Get-LogCount "WARN") - $warn0
  [int]$newErr = (Get-LogCount "ERROR") - $err0
  $fields = @(
    $now.ToString("s"),
    [math]::Round(($now - $start).TotalMinutes, 1),
    [int]($app.WorkingSet64 / 1MB),
    [int]($app.PrivateMemorySize64 / 1MB),
    [math]::Round($appCpu, 1),
    $app.HandleCount,
    $app.Threads.Count,
    $wv.Count,
    [int]($wvWs / 1MB),
    [int]($wvPriv / 1MB),
    [math]::Round($wvCpu, 1),
    $newWarn,
    $newErr
  )
  ($fields -join ",") | Out-File $Out -Append -Encoding utf8
  Start-Sleep -Seconds $IntervalSec
}
