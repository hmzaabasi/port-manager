$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)

if ($connections.Count -eq 0) {
  [Console]::Out.Write('[]')
  exit 0
}

$idList = @(
  $connections |
    ForEach-Object { [int]$_.OwningProcess } |
    Select-Object -Unique
)

$processes = @{}
Get-CimInstance -ClassName Win32_Process |
  Where-Object { $idList -contains [int]$_.ProcessId } |
  ForEach-Object {
    $processes[[int]$_.ProcessId] = $_
  }

$rows = foreach ($conn in $connections) {
  $procId = [int]$conn.OwningProcess
  $proc = $processes[$procId]
  [PSCustomObject]@{
    address = [string]$conn.LocalAddress
    port    = [int]$conn.LocalPort
    pid     = $procId
    name    = if ($null -ne $proc -and $proc.Name) { [string]$proc.Name } else { '' }
    path    = if ($null -ne $proc -and $proc.ExecutablePath) { [string]$proc.ExecutablePath } else { '' }
    command = if ($null -ne $proc -and $proc.CommandLine) { [string]$proc.CommandLine } else { '' }
  }
}

$json = ConvertTo-Json -InputObject @($rows) -Compress -Depth 4
[Console]::Out.Write($json)
