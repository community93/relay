$ErrorActionPreference = 'SilentlyContinue'
$relay = Get-Process -Name 'Relay' | Select-Object -First 1
if (-not $relay) { 'Relay not running'; exit }
"Relay PID = $($relay.Id)"

$all = Get-CimInstance Win32_Process
# walk the tree: webview2 browser process is a direct child of Relay, the rest nest under it
$family = @($relay.Id)
for ($i = 0; $i -lt $family.Count; $i++) {
  foreach ($p in $all) {
    if ($p.ParentProcessId -eq $family[$i] -and $family -notcontains $p.ProcessId) { $family += $p.ProcessId }
  }
}
"Descendants = $($family.Count - 1)"

$sum = 0; $privSum = 0; $commitSum = 0
foreach ($id in $family) {
  $proc = Get-Process -Id $id
  if (-not $proc) { continue }
  $ws = [math]::Round($proc.WorkingSet64/1MB,1)
  $pv = [math]::Round($proc.PrivateMemorySize64/1MB,1)
  $vm = [math]::Round($proc.VirtualMemorySize64/1MB,1)
  $sum += $ws; $privSum += $pv
  $role = ($all | Where-Object { $_.ProcessId -eq $id }).CommandLine
  $type = 'other'
  if ($role -match '--type=(\w+)') { $type = $Matches[1] }
  elseif ($proc.ProcessName -eq 'Relay') { $type = 'rust host' }
  '{0,-6} {1,-16} WS={2,7} Priv={3,7}  {4}' -f $id, $proc.ProcessName, $ws, $pv, $type
}
''
'WorkingSet total : {0} MB' -f [math]::Round($sum,1)
'Private  total   : {0} MB' -f [math]::Round($privSum,1)
