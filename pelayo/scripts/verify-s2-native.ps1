# verify-s2-native.ps1 - Verificación nativa Sprint 2 (WhatsApp Mínimo Seguro)
# Requiere: PostgreSQL 16 local y Node.js en PATH

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path "$scriptDir\.."
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source

if (-not $nodeExe) {
    $fallbackNode = "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    if (Test-Path $fallbackNode) {
        $nodeExe = $fallbackNode
    } else {
        Write-Error "No se encontro node.exe en PATH ni en $fallbackNode."
        exit 1
    }
}

$verifyJs = "$scriptDir\verify-s2-native.js"
Write-Host "Ejecutando verificacion nativa Sprint 2 con Node: $nodeExe..." -ForegroundColor Cyan

& $nodeExe $verifyJs
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
    Write-Host "`n>>> SPRINT 2 VERIFICADO EXITOSAMENTE (Exit Code: 0) <<<" -ForegroundColor Green
} else {
    Write-Error "`n>>> FALLO EN LA VERIFICACION DEL SPRINT 2 (Exit Code: $exitCode) <<<"
}

exit $exitCode
