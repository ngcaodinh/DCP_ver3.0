param(
  [string]$JMeterBin = "D:\tools\apache-jmeter\bin\jmeter.bat",
  [string]$PropertiesFile = "$(Join-Path $PSScriptRoot 'kyc-to-disbursement-synthetic.local.properties')"
)

$ErrorActionPreference = "Stop"
$JMeterBin = ($JMeterBin -replace "[\r\n\t]", "").Trim()
$PropertiesFile = (Resolve-Path -LiteralPath $PropertiesFile -ErrorAction Stop).Path
$Plan = Join-Path $PSScriptRoot "dcp-kyc-to-disbursement-synthetic.jmx"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ResultDir = Join-Path $PSScriptRoot "results-kyc-to-disbursement-synthetic-$Stamp"
$Jtl = Join-Path $ResultDir "result.jtl"
$Report = Join-Path $ResultDir "html-report"

if (!(Test-Path -LiteralPath $JMeterBin)) { throw "Không tìm thấy JMeter tại $JMeterBin." }
if (!(Test-Path -LiteralPath $Plan)) { throw "Không tìm thấy JMeter plan tại $Plan." }

New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null
& $JMeterBin -n -t $Plan -q $PropertiesFile -l $Jtl -e -o $Report
if ($LASTEXITCODE -ne 0) { throw "JMeter thất bại với exit code $LASTEXITCODE. Xem $Jtl." }

Write-Host "DONE: synthetic KYC-to-disbursement E2E"
Write-Host "JTL: $Jtl"
Write-Host "HTML report: $(Join-Path $Report 'index.html')"
