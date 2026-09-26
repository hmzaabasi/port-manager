param(
  [Parameter(Mandatory = $true)]
  [string]$Ids
)

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$parsed = @(
  $Ids.Split(',') |
    Where-Object { $_ -match '^\d+$' } |
    ForEach-Object { [int]$_ } |
    Select-Object -Unique
)

if ($parsed.Count -eq 0) {
  [Console]::Out.Write('[]')
  exit 0
}

$collected = @()
for ($offset = 0; $offset -lt $parsed.Count; $offset += 20) {
  $end = [Math]::Min($offset + 19, $parsed.Count - 1)
  $slice = @($parsed[$offset..$end])
  $filter = ($slice | ForEach-Object { "ProcessId=$_" }) -join ' OR '
  $batch = @(
    Get-CimInstance -ClassName Win32_Process -Filter $filter | ForEach-Object {
      [PSCustomObject]@{
        pid     = [int]$_.ProcessId
        path    = if ($_.ExecutablePath) { [string]$_.ExecutablePath } else { '' }
        command = if ($_.CommandLine) { [string]$_.CommandLine } else { '' }
      }
    }
  )
  if ($batch.Count -gt 0) {
    $collected += $batch
  }
}

if ($collected.Count -eq 0) {
  [Console]::Out.Write('[]')
  exit 0
}

if ($collected.Count -eq 1) {
  $json = '[' + (ConvertTo-Json -InputObject $collected[0] -Compress -Depth 3) + ']'
} else {
  $json = ConvertTo-Json -InputObject @($collected) -Compress -Depth 3
}

[Console]::Out.Write($json)
