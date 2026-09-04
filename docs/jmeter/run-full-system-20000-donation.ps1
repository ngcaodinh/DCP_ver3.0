param(
  [string]$JMeterBin = "D:\tools\apache-jmeter\bin\jmeter.bat",
  [string]$PropertiesFile = "$(Join-Path $PSScriptRoot 'full-system-20000-donation.local.properties')"
)

$ErrorActionPreference = "Stop"
$JMeterBin = ($JMeterBin -replace "[\r\n\t]", "").Trim()
$PropertiesFile = (Resolve-Path -LiteralPath $PropertiesFile -ErrorAction Stop).Path
$Plan = Join-Path $PSScriptRoot "dcp-full-system-20000-donation.jmx"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ResultDir = Join-Path $PSScriptRoot "results-full-system-20000-donation-$Stamp"
$Jtl = Join-Path $ResultDir "result.jtl"
$Report = Join-Path $ResultDir "html-report"

if (!(Test-Path -LiteralPath $JMeterBin)) { throw "Không tìm thấy JMeter tại $JMeterBin." }
if (!(Test-Path -LiteralPath $Plan)) { throw "Không tìm thấy JMeter plan tại $Plan." }

New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null
& $JMeterBin -n -t $Plan -q $PropertiesFile -l $Jtl -e -o $Report
if ($LASTEXITCODE -ne 0) { throw "JMeter thất bại với exit code $LASTEXITCODE. Xem $Jtl." }

Write-Host "DONE: synthetic full-system KYC -> 20000 donations -> disbursement"
Write-Host "JTL: $Jtl"
Write-Host "HTML report: $(Join-Path $Report 'index.html')"
