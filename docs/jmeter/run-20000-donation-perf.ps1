param(
  [string]$JMeterBin = "D:\tools\apache-jmeter\bin\jmeter.bat",
  [string]$PropertiesFile = "$(Join-Path $PSScriptRoot 'dcp-20000-donation-perf.local.properties')"
)

$ErrorActionPreference = "Stop"
$JMeterBin = ($JMeterBin -replace "[\r\n\t]", "").Trim()
$PropertiesFile = (Resolve-Path -LiteralPath $PropertiesFile -ErrorAction Stop).Path
$Plan = Join-Path $PSScriptRoot "dcp-20000-donation-perf.jmx"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$ResultDir = Join-Path $PSScriptRoot "results-donation-$Stamp"
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
  throw "JMeter thất bại với exit code $LASTEXITCODE. Xem $Jtl để biết request lỗi."
}

Write-Host "DONE: donation performance result"
Write-Host "JTL: $Jtl"
Write-Host "HTML report: $(Join-Path $Report 'index.html')"
