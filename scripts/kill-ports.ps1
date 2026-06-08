# Script to free ports for local FE/BE development
$ports = @(3000, 4000)

Write-Host "Checking for processes on ports..." -ForegroundColor Cyan

foreach ($port in $ports) {
    Write-Host "Checking port $port..." -ForegroundColor Yellow

    $connections = netstat -ano | Where-Object { $_ -match 'LISTENING' } | Where-Object { $_ -match ":$port " }

    if ($connections) {
        foreach ($connection in $connections) {
            $parts = $connection.ToString().Trim() -replace '\s+', ' ' -split ' '
            $processId = $parts[-1]

            if ($processId -match '^\d+$') {
                $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
                if ($process) {
                    Write-Host "  Killing process: $($process.ProcessName) (PID: $processId) on port $port" -ForegroundColor Red
                    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                    Write-Host "  Process killed successfully." -ForegroundColor Green
                }
            }
        }
    } else {
        Write-Host "  Port $port is free." -ForegroundColor Green
    }
}

Write-Host "Port cleanup completed!" -ForegroundColor Green

