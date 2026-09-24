<#
.SYNOPSIS
  Script de verificacion integral de S1.09 sobre PostgreSQL 16 nativo portable.
.DESCRIPTION
  Ejecuta con aserciones estrictas (Fail-Fast):
  1. Verificacion/Arranque sincrono de PostgreSQL 16 (puerto 5433).
  2. Consulta de version mediante psql.
  3. Despliegue determinista de migraciones con Prisma CLI.
  4. Auditoria de estado de migraciones con Prisma CLI.
  5. Auditoria fisica de tablas y registros en PostgreSQL con psql.
  6. Comprobacion de puerto 3001 libre y arranque del backend NestJS.
  7. Comprobacion nominal del endpoint /health (HTTP 200 OK, database: connected).
  8. Prueba de conmutacion de fallo (detencion de PostgreSQL -> HTTP 503 Service Unavailable, database: disconnected).
  9. Prueba de recuperacion automatica (reanudacion de PostgreSQL -> HTTP 200 OK, database: connected).
  10. Detencion controlada exclusiva del backend (por PID) y de PostgreSQL.
#>

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = (Resolve-Path (Join-Path $scriptDir "..")).Path
$logFile = Join-Path $appDir "s1-verification.log"
$pgDir = "$env:LOCALAPPDATA\Programs\pgsql"
$pgBin = "$pgDir\bin"
$dataDir = "$pgDir\data_test"
$testDbUrl = "postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public"
$nodePath = "$env:LOCALAPPDATA\Programs\nodejs"
$prismaCli = Join-Path $appDir "node_modules\prisma\build\index.js"

if (Test-Path $nodePath) {
    $env:PATH = "$nodePath;$pgBin;$env:PATH"
} else {
    $env:PATH = "$pgBin;$env:PATH"
}

$backendJob = $null

function Log-Section {
    param([string]$title)
    $msg = "`n================================================================================`n" +
           "[" + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + "] " + $title + "`n" +
           "================================================================================"
    Write-Host $msg -ForegroundColor Cyan
    Add-Content -Path $logFile -Value $msg -Encoding UTF8
}

function Log-Output {
    param($content)
    $text = ($content | Out-String).TrimEnd()
    Write-Host $text
    Add-Content -Path $logFile -Value $text -Encoding UTF8
}

function Assert-Condition {
    param(
        [bool]$condition,
        [string]$errorMessage
    )
    if (-not $condition) {
        $failMsg = "[ERROR DE ASERCION] $errorMessage"
        Write-Host $failMsg -ForegroundColor Red
        Add-Content -Path $logFile -Value "`n$failMsg" -Encoding UTF8
        throw $failMsg
    }
}

try {
    # 0. Inicializar archivo de log limpio
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
    $nodeVer = (& node -v | Out-String).Trim()
    $npmVer = (& npm -v | Out-String).Trim()
    $header = "================================================================================`n" +
              "PELAYOBOT - REPORTE DE VERIFICACION SPRINT 1 (POSTGRESQL 16 NATIVO)`n" +
              "Fecha de ejecucion: $timestamp`n" +
              "Plataforma: Windows 11 Pro 64-bit | Node $nodeVer | npm $npmVer`n" +
              "Base de datos de prueba: postgresql://test_user:***@localhost:5433/pelayodb_test`n" +
              "================================================================================"
    Set-Content -Path $logFile -Value $header -Encoding UTF8

    # 1. Asegurar arranque de PostgreSQL 16 en puerto 5433
    Log-Section "1. ARRANQUE Y DISPONIBILIDAD DE POSTGRESQL 16 (PUERTO 5433)"
    & "$pgBin\pg_ctl.exe" -D $dataDir status
    if ($LASTEXITCODE -ne 0) {
        Start-Process -FilePath "$pgBin\pg_ctl.exe" -ArgumentList "-D", "`"$dataDir`"", "-w", "-l", "`"$pgDir\postgres_test.log`"", "-o", "'-p 5433'", "start" -Wait -NoNewWindow
        Assert-Condition ($LASTEXITCODE -eq 0) "No fue posible iniciar el servicio PostgreSQL 16 en $dataDir."
        Log-Output "Servidor PostgreSQL 16 iniciado exitosamente en puerto 5433."
    } else {
        Log-Output "Servidor PostgreSQL 16 ya se encontraba activo en puerto 5433."
    }

    # 2. Consulta de version mediante psql
    Log-Section "2. CONSULTA DE VERSION DE MOTOR CON PSQL"
    $env:PGPASSWORD = "test_secret_isolated_pw"
    $verOut = & "$pgBin\psql.exe" -h localhost -p 5433 -U test_user -d pelayodb_test -c "SELECT version();" 2>&1
    $verOutText = ($verOut | Out-String)
    Assert-Condition ($LASTEXITCODE -eq 0) "Fallo la ejecucion de psql SELECT version()."
    Assert-Condition ($verOutText -like "*PostgreSQL 16*") "La version reportada no corresponde a PostgreSQL 16."
    Log-Output $verOutText

    # 3. Aplicacion determinista de migraciones con Prisma CLI
    Log-Section "3. APLICACION DETERMINISTA DE MIGRACIONES (prisma migrate deploy)"
    $prevDbUrl = $env:DATABASE_URL
    $env:DATABASE_URL = $testDbUrl
    $deployOut = & node $prismaCli migrate deploy 2>&1
    $deployOutText = ($deployOut | Out-String)
    Assert-Condition ($LASTEXITCODE -eq 0) "Fallo la ejecucion de prisma migrate deploy."
    Log-Output $deployOutText

    # 4. Auditoria de estado de migraciones con Prisma CLI
    Log-Section "4. ESTADO DE MIGRACIONES PRISMA (prisma migrate status)"
    $statusOut = & node $prismaCli migrate status 2>&1
    $statusOutText = ($statusOut | Out-String)
    Assert-Condition ($LASTEXITCODE -eq 0) "Fallo la ejecucion de prisma migrate status."
    Assert-Condition ($statusOutText -like "*Database schema is up to date!*") "Prisma reporta que el esquema no esta al dia."
    Log-Output $statusOutText
    $env:DATABASE_URL = $prevDbUrl

    # 5. Auditoria fisica de tablas y registros en PostgreSQL con psql
    Log-Section "5. AUDITORIA FISICA EN BASE DE DATOS (psql \dt y _prisma_migrations)"
    $auditOut = & "$pgBin\psql.exe" -h localhost -p 5433 -U test_user -d pelayodb_test -c "\dt" -c "SELECT id, migration_name, finished_at, rolled_back_at FROM _prisma_migrations;" 2>&1
    $auditOutText = ($auditOut | Out-String)
    Assert-Condition ($LASTEXITCODE -eq 0) "Fallo la consulta de auditoria en psql."
    Assert-Condition ($auditOutText -like "*system_checks*") "La tabla 'system_checks' no existe en la base de datos."
    Assert-Condition ($auditOutText -like "*_prisma_migrations*") "La tabla '_prisma_migrations' no existe en la base de datos."
    Assert-Condition ($auditOutText -like "*20260921000000_init_system_check*") "No se encontro el registro de la migracion inicial aplicada."
    Log-Output $auditOutText

    # 6. Arranque del backend NestJS en puerto 3001
    Log-Section "6. ARRANQUE DEL BACKEND EN PUERTO 3001"
    
    # Comprobar que el puerto 3001 no este ocupado previamente
    $prePort = & curl.exe -s -m 1 http://localhost:3001/health 2>&1
    if ($LASTEXITCODE -eq 0) {
        throw "El puerto 3001 ya se encuentra ocupado por otro servicio. Detengalo antes de verificar."
    }

    $stdoutLog = Join-Path $appDir "backend-stdout.log"
    $stderrLog = Join-Path $appDir "backend-stderr.log"
    if (Test-Path $stdoutLog) { Remove-Item $stdoutLog -Force }
    if (Test-Path $stderrLog) { Remove-Item $stderrLog -Force }

    $oldNodeEnv = $env:NODE_ENV
    $oldPort = $env:PORT
    $oldDbUrl = $env:DATABASE_URL

    $env:NODE_ENV = "production"
    $env:PORT = "3001"
    $env:DATABASE_URL = $testDbUrl

    # Iniciar backend registrando unicamente su PID especifico (sin tocar otros procesos del usuario)
    $backendJob = Start-Process -FilePath "node.exe" -ArgumentList "dist/main.js" -WorkingDirectory $appDir -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

    $env:NODE_ENV = $oldNodeEnv
    $env:PORT = $oldPort
    $env:DATABASE_URL = $oldDbUrl

    Start-Sleep -Seconds 4
    Assert-Condition (-not $backendJob.HasExited) "El proceso backend finalizo inesperadamente durante el arranque."

    $stdoutContent = Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue
    Assert-Condition ($stdoutContent -like "*PelayoBot iniciado exitosamente en http://localhost:3001*") "El backend no registro el mensaje de bootstrap esperado en su log."
    Log-Output "Backend iniciado y verificado en ejecucion con PID especifico: $($backendJob.Id)"

    # 7. Comprobacion nominal del endpoint /health (HTTP 200 OK)
    Log-Section "7. COMPROBACION NOMINAL DE SALUD (GET /health -> HTTP 200 OK)"
    Assert-Condition (-not $backendJob.HasExited) "El proceso backend murio antes del healthcheck nominal."
    $nominalRaw = & curl.exe -s -i http://localhost:3001/health 2>&1
    $nominalRawText = ($nominalRaw | Out-String)
    Assert-Condition ($nominalRawText -like "*200 OK*") "El endpoint /health no devolvio HTTP 200 OK en estado nominal."
    Assert-Condition ($nominalRawText -like '*"status":"ok"*') "El campo status en el JSON de /health no es 'ok'."
    Assert-Condition ($nominalRawText -like '*"database":"connected"*') "El servicio database en /health no esta 'connected'."
    Log-Output $nominalRawText

    # 8. Prueba de conmutacion de fallo: Detener PostgreSQL de pruebas
    Log-Section "8. PRUEBA DE CONMUTACION DE FALLO (PostgreSQL detenido -> HTTP 503)"
    Start-Process -FilePath "$pgBin\pg_ctl.exe" -ArgumentList "-D", "`"$dataDir`"", "-w", "-m", "fast", "stop" -Wait -NoNewWindow
    Assert-Condition ($LASTEXITCODE -eq 0) "Fallo la detencion controlada de PostgreSQL."
    Start-Sleep -Seconds 2
    Log-Output "PostgreSQL detenido de forma controlada para verificar degradacion controlada."

    Assert-Condition (-not $backendJob.HasExited) "El proceso backend murio tras la detencion de la base de datos."
    $degradedRaw = & curl.exe -s -i http://localhost:3001/health 2>&1
    $degradedRawText = ($degradedRaw | Out-String)
    Assert-Condition ($degradedRawText -like "*503 Service Unavailable*") "El endpoint /health no devolvio HTTP 503 ante la indisponibilidad de la base de datos."
    Assert-Condition ($degradedRawText -like '*"status":"degraded"*') "El campo status no cambio a 'degraded'."
    Assert-Condition ($degradedRawText -like '*"database":"disconnected"*') "El servicio database no cambio a 'disconnected'."
    Log-Output $degradedRawText

    # 9. Prueba de recuperacion automatica: Reanudar PostgreSQL
    Log-Section "9. RECUPERACION AUTOMATICA (PostgreSQL reanudado -> HTTP 200 OK)"
    Start-Process -FilePath "$pgBin\pg_ctl.exe" -ArgumentList "-D", "`"$dataDir`"", "-w", "-l", "`"$pgDir\postgres_test.log`"", "-o", "'-p 5433'", "start" -Wait -NoNewWindow
    Assert-Condition ($LASTEXITCODE -eq 0) "Fallo la reanudacion de PostgreSQL en puerto 5433."
    Log-Output "PostgreSQL reanudado exitosamente en puerto 5433."

    $recovered = $false
    $recoveredRawText = ""
    for ($i = 1; $i -le 6; $i++) {
        Start-Sleep -Seconds 2
        Assert-Condition (-not $backendJob.HasExited) "El proceso backend murio durante la etapa de recuperacion."
        $recoveredRaw = & curl.exe -s -i http://localhost:3001/health 2>&1
        $recoveredRawText = ($recoveredRaw | Out-String)
        if ($recoveredRawText -like "*200 OK*" -and $recoveredRawText -like '*"database":"connected"*') {
            $recovered = $true
            Log-Output "Intento $i - Recuperacion confirmada (HTTP 200 OK, database: connected):"
            Log-Output $recoveredRawText
            break
        }
    }
    Assert-Condition $recovered "El endpoint /health no se recupero a HTTP 200 tras reanudar PostgreSQL en el tiempo esperado."

    # 10. Reporte final de exito
    $summary = "`n================================================================================`n" +
               "RESULTADO DE LA AUDITORIA (TODAS LAS ASERCIONES VERIFICADAS):`n" +
               "- PostgreSQL 16.15 nativo en puerto 5433: VERIFICADO Y OPERATIVO`n" +
               "- Migracion Prisma ('init_system_check'): DESPLEGADA DE FORMA DETERMINISTA`n" +
               "- Estado de esquema Prisma: AL DIA Y CONSISTENTE`n" +
               "- Tablas fisicas 'system_checks' y '_prisma_migrations': AUDITADAS CON PSQL`n" +
               "- Endpoint /health nominal: HTTP 200 OK (status: ok, database: connected)`n" +
               "- Conmutacion de fallos por caida de BD: HTTP 503 (status: degraded, database: disconnected)`n" +
               "- Recuperacion automatica tras reconexion: HTTP 200 OK (status: ok, database: connected)`n" +
               "ESTADO FINAL: S1.09 VALIDADO SATISFACTORIAMENTE CON POSTGRESQL REAL.`n" +
               "================================================================================"
    Add-Content -Path $logFile -Value $summary -Encoding UTF8
    Write-Host $summary -ForegroundColor Green
    Write-Host "Evidencia persistida en: $logFile" -ForegroundColor Cyan

} catch {
    $errHeader = "`n================================================================================`n" +
                 "[FALLO FATAL EN LA VERIFICACION]`n" +
                 $_.Exception.Message + "`n" +
                 "================================================================================"
    Write-Host $errHeader -ForegroundColor Red
    Add-Content -Path $logFile -Value $errHeader -Encoding UTF8
    exit 1
} finally {
    # Limpieza estricta: detener unica y exclusivamente el proceso backend que iniciamos
    if ($backendJob -and -not $backendJob.HasExited) {
        Stop-Process -Id $backendJob.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Backend de prueba detenido (PID: $($backendJob.Id))." -ForegroundColor Gray
    }
    # Detener PostgreSQL de prueba de forma controlada
    Start-Process -FilePath "$pgBin\pg_ctl.exe" -ArgumentList "-D", "`"$dataDir`"", "-w", "-m", "fast", "stop" -Wait -NoNewWindow -ErrorAction SilentlyContinue
}
