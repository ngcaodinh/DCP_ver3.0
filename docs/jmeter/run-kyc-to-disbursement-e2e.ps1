param(
  [string]$JMeterBin = "D:\tools\apache-jmeter\bin\jmeter.bat",
  [string]$PropertiesFile = "$(Join-Path $PSScriptRoot 'kyc-to-disbursement-e2e.local.properties')"
)

$ErrorActionPreference = "Stop"
$JMeterBin = ($JMeterBin -replace "[\r\n\t]", "").Trim()
$PropertiesFile = (Resolve-Path -LiteralPath $PropertiesFile -ErrorAction Stop).Path
$Plan = Join-Path $PSScriptRoot "dcp-kyc-to-disbursement-e2e.jmx"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ResultDir = Join-Path $PSScriptRoot "results-e2e-$Stamp"
$Jtl = Join-Path $ResultDir "result.jtl"
$Report = Join-Path $ResultDir "html-report"

if (!(Test-Path -LiteralPath $JMeterBin)) {
  throw "Không tìm thấy JMeter tại $JMeterBin. Hãy truyền -JMeterBin 'đường_dẫn_jmeter.bat'."
}
if (!(Test-Path -LiteralPath $Plan)) {
  throw "Không tìm thấy JMeter plan tại $Plan."
}

New-Item -ItemType Directory -Force -Path $ResultDir | Out-Null
& $JMeterBin -n -t $Plan -q $PropertiesFile -l $Jtl -e -o $Report
if ($LASTEXITCODE -ne 0) {
  throw "JMeter thất bại với exit code $LASTEXITCODE. Xem $Jtl để biết bước lỗi."
}

Write-Host "DONE: KYC to disbursement E2E"
Write-Host "DCP_E2E_MS nằm trong jmeter.log và sampler 'Record e2e elapsed milliseconds'."
Write-Host "JTL: $Jtl"
Write-Host "HTML report: $(Join-Path $Report 'index.html')"
