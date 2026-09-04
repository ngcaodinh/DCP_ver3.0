param(
  [string]$JMeterBin = "D:\tools\apache-jmeter\bin\jmeter.bat",
  [string]$Protocol = "http",
  [string]$HostName = "localhost",
  [int]$Port = 4000,
  [string]$Path = "/health",
  [int]$Users = 200,
  [int]$Loops = 100,
  [int]$RampUp = 120
)

$ErrorActionPreference = "Stop"
$JMeterBin = ($JMeterBin -replace "[\r\n\t]", "").Trim()
$Root = Split-Path -Parent $PSScriptRoot
$Plan = Join-Path $PSScriptRoot "dcp-20000-health-test.jmx"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ResultDir = Join-Path $PSScriptRoot "results-$Stamp"
$Jtl = Join-Path $ResultDir "result.jtl"
$Report = Join-Path $ResultDir "html-report"

if (!(Test-Path $JMeterBin)) {
  throw "Không tìm thấy JMeter tại $JMeterBin. Hãy truyền -JMeterBin 'đường_dẫn_jmeter.bat'."
}

New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null

& $JMeterBin -n -t $Plan -l $Jtl -e -o $Report "-Jprotocol=$Protocol" "-Jhost=$HostName" "-Jport=$Port" "-Jpath=$Path" "-Jusers=$Users" "-Jloops=$Loops" "-Jrampup=$RampUp"

Write-Host ""
Write-Host "DONE: $($Users * $Loops) requests"
Write-Host "JTL: $Jtl"
Write-Host "HTML report: $Report\index.html"
Start-Process (Join-Path $Report "index.html")
