<#
.SYNOPSIS
  Inicializa el entorno de PostgreSQL 16 portable para pruebas aisladas en Windows x64.
.DESCRIPTION
  Descarga los binarios oficiales de PostgreSQL 16 si no existen,
  inicializa el cluster data_test en el puerto 5433,
  crea el usuario test_user y la base de datos pelayodb_test.
#>

$ErrorActionPreference = "Stop"

$pgDir = "$env:LOCALAPPDATA\Programs\pgsql"
$dataDir = "$pgDir\data_test"
$zipFile = "$env:TEMP\postgresql-16-binaries.zip"
$downloadUrl = "https://get.enterprisedb.com/postgresql/postgresql-16.15-4-windows-x64-binaries.zip"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Configuración de PostgreSQL 16 Aislado (Puerto 5433)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verificar o descargar binarios portátiles
if (-not (Test-Path "$pgDir\bin\postgres.exe")) {
    Write-Host "[1/4] Descargando PostgreSQL 16.15 para Windows x64..." -ForegroundColor Yellow
    & curl.exe -L -o $zipFile $downloadUrl
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Fallo la descarga de los binarios oficiales de PostgreSQL (Exit code: $LASTEXITCODE)."
        exit 1
    }
    
    Write-Host "[2/4] Descomprimiendo en $pgDir..." -ForegroundColor Yellow
    if (-not (Test-Path "$env:LOCALAPPDATA\Programs")) {
        New-Item -ItemType Directory -Path "$env:LOCALAPPDATA\Programs" -Force | Out-Null
    }
    & tar.exe -xf $zipFile -C "$env:LOCALAPPDATA\Programs"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Fallo la descompresion del archivo zip con tar.exe (Exit code: $LASTEXITCODE)."
        exit 1
    }
    Remove-Item $zipFile -Force
    Write-Host "      Binarios listos en $pgDir\bin." -ForegroundColor Green
} else {
    Write-Host "[1/4] Binarios de PostgreSQL 16 encontrados en $pgDir\bin." -ForegroundColor Green
}

# 2. Inicializar cluster de datos si no existe
if (-not (Test-Path "$dataDir\PG_VERSION")) {
    if (Test-Path $dataDir) {
        $existingItems = Get-ChildItem -Path $dataDir -Force
        if ($existingItems.Count -gt 0) {
            Write-Error "El directorio de datos '$dataDir' ya existe y no esta vacio, pero no contiene un archivo PG_VERSION valido.`nPara prevenir la perdida accidental de datos, este instalador no lo eliminara automaticamente.`nPor favor, mueva, respalde o elimine manualmente el directorio antes de reintentar."
            exit 1
        }
    }

    Write-Host "[3/4] Inicializando cluster de base de datos en $dataDir..." -ForegroundColor Yellow
    
    $pwFile = "$env:TEMP\pg_pw_$PID.txt"
    Set-Content -Path $pwFile -Value "test_secret_isolated_pw" -NoNewline
    
    & "$pgDir\bin\initdb.exe" -D $dataDir -U test_user -A scram-sha-256 --pwfile=$pwFile -E UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) {
        Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
        Write-Error "Fallo la inicializacion del cluster con initdb.exe (Exit code: $LASTEXITCODE)."
        exit 1
    }
    Remove-Item $pwFile -Force
    
    # 3. Arrancar temporalmente para crear la base de datos pelayodb_test
    Write-Host "[4/4] Creando base de datos pelayodb_test..." -ForegroundColor Yellow
    & "$pgDir\bin\pg_ctl.exe" -D $dataDir -w -l "$pgDir\postgres_test.log" -o "-p 5433" start
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Fallo el arranque temporal de PostgreSQL en puerto 5433 (Exit code: $LASTEXITCODE)."
        exit 1
    }
    Start-Sleep -Seconds 1
    
    $env:PGPASSWORD = "test_secret_isolated_pw"
    & "$pgDir\bin\createdb.exe" -h localhost -p 5433 -U test_user pelayodb_test
    if ($LASTEXITCODE -ne 0) {
        & "$pgDir\bin\pg_ctl.exe" -D $dataDir -w stop -m fast
        Write-Error "Fallo la creacion de la base de datos pelayodb_test con createdb.exe (Exit code: $LASTEXITCODE)."
        exit 1
    }
    
    # Detener motor temporal de forma síncrona
    & "$pgDir\bin\pg_ctl.exe" -D $dataDir -w stop -m fast
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Fallo la detencion del motor temporal con pg_ctl.exe (Exit code: $LASTEXITCODE)."
        exit 1
    }
    Write-Host "      Base de datos pelayodb_test creada exitosamente." -ForegroundColor Green
} else {
    Write-Host "[2/2] Cluster de datos y base de datos existentes en $dataDir." -ForegroundColor Green
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Entorno de pruebas preparado exitosamente." -ForegroundColor Green
Write-Host " Para iniciar el servicio:  npm run db:test:start" -ForegroundColor White
Write-Host " Para aplicar migraciones:  npm run prisma:deploy (con DATABASE_URL)" -ForegroundColor White
Write-Host " Para detener el servicio:  npm run db:test:stop" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
