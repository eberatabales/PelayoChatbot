# PelayoBot - Backend

Backend modular basado en **NestJS**, **TypeScript**, **PostgreSQL**, **Prisma** y **WhatsApp Cloud API**.

## 1. Requisitos Previos

- **Node.js**: v20 LTS o superior
- **npm**: v10 o superior
- **Docker y Docker Compose** (para PostgreSQL local)

## 2. Configuración Inicial

1. Clona o ubícate en el directorio del proyecto:
   ```bash
   cd pelayo
   ```

2. Copia la plantilla de variables de entorno:
   ```bash
   cp .env.example .env
   ```

3. Ajusta las variables en `.env` si es necesario (valores por defecto preparados para entorno local).

4. Instala las dependencias del proyecto de forma limpia y reproducible:
   ```bash
   npm ci
   ```

## 3. Levantar Base de Datos (PostgreSQL)

Para iniciar la base de datos PostgreSQL en segundo plano con Docker Compose:

```bash
docker compose up -d postgres
```

Para verificar que el contenedor esté saludable:
```bash
docker compose ps
```

## 4. Generación de Cliente Prisma y Migraciones

### 4.1 Entorno Habitual de Desarrollo (Puerto 5432)

Generar el cliente Prisma en TypeScript:
```bash
npm run prisma:generate
```

Aplicar migraciones pendientes de forma determinista (producción / CI / staging):
```bash
npm run prisma:deploy
```

> [!WARNING]
> **Advertencia de Entorno:**
> `npm run prisma:deploy` lee por defecto la variable `DATABASE_URL` definida en el archivo `.env` local (que apunta a `localhost:5432` / `pelayodb`).
> Si estás probando la base de datos aislada (`docker-compose.test.yml` en el puerto `5433`), **NUNCA** ejecutes `npm run prisma:deploy` directamente sin sobreescribir `DATABASE_URL`, ya que aplicarías las migraciones a la base habitual o fallaría si el puerto 5432 está inactivo.

Consultar el estado de las migraciones aplicadas en la base habitual:
```bash
npm run prisma:status
```

Crear o aplicar migraciones interactivas en desarrollo:
```bash
npm run prisma:migrate
```

---

### 4.2 Entorno Aislado de Pruebas (Puerto 5433 / S1.09)

Para verificar el arranque de la aplicación y la aplicación de migraciones sin riesgo de alterar la base de datos de desarrollo ni modificar el archivo `.env`, se dispone del archivo `docker-compose.test.yml` (PostgreSQL en puerto `5433` y base `pelayodb_test`).

#### Opción A: Flujo Completamente Automatizado en Docker

El archivo `docker-compose.test.yml` orquesta automáticamente la secuencia completa:
1. `postgres_test`: levanta PostgreSQL 16 Alpine en el puerto `5433` y ejecuta su healthcheck.
2. `migration_test`: contenedor efímero (target `builder` con CLI de Prisma) que espera a que `postgres_test` esté saludable y ejecuta `npx prisma migrate deploy`.
3. `backend_test`: espera a que `migration_test` concluya exitosamente (`condition: service_completed_successfully`) antes de arrancar la aplicación en el puerto `3001`.

```bash
# Levantar todo el stack de pruebas (Postgres + Migración + Backend)
docker compose -f docker-compose.test.yml up --build
```

Comprobar el endpoint de salud desde el host (valida físicamente la tabla `system_checks` y el registro en `_prisma_migrations`):
```bash
curl http://localhost:3001/health
```

Respuesta esperada (HTTP 200):
```json
{
  "status": "ok",
  "timestamp": "2026-09-21T19:30:00.000Z",
  "uptime": 2.15,
  "environment": "production",
  "services": {
    "database": "connected"
  }
}
```

#### Opción B: Migración Manual desde el Host hacia el Puerto 5433

Si prefieres ejecutar las migraciones desde tu máquina local apuntando a la base de pruebas aislada:

1. **Levantar únicamente el contenedor PostgreSQL de pruebas:**
   ```bash
   docker compose -f docker-compose.test.yml up -d postgres_test
   ```

2. **Ejecutar las migraciones apuntando explícitamente al puerto 5433 (sin alterar `.env`):**
    - En **PowerShell** (utiliza `try/finally` para asegurar que `$env:DATABASE_URL` se restaure al valor previo al finalizar):
      ```powershell
      $prevUrl = $env:DATABASE_URL
      try {
        $env:DATABASE_URL = "postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public"
        npm run prisma:deploy
        npm run prisma:status
      } finally {
        $env:DATABASE_URL = $prevUrl
      }
      ```
    - En **Bash / Linux / macOS** (asigna la variable de entorno únicamente para el subproceso de ejecución):
      ```bash
      DATABASE_URL="postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public" npm run prisma:deploy
      DATABASE_URL="postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public" npm run prisma:status
      ```

3. **Verificar físicamente las tablas y el registro de migración en PostgreSQL:**
   ```bash
   # Listar tablas creadas (debe mostrar system_checks)
   docker exec -it pelayobot_test_postgres psql -U test_user -d pelayodb_test -c "\dt"

   # Consultar el registro formal de la migración en _prisma_migrations
   docker exec -it pelayobot_test_postgres psql -U test_user -d pelayodb_test -c "SELECT id, migration_name, finished_at, rolled_back_at FROM _prisma_migrations;"
   ```

4. **Detención y limpieza del entorno de pruebas Docker:**
   ```bash
   # Cierre habitual: detiene los contenedores preservando el volumen con los datos y la evidencia de las migraciones:
   docker compose -f docker-compose.test.yml down

   # (Opcional) Limpieza profunda: borra también el volumen aislado si deseas reiniciar las pruebas desde un estado completamente vacío:
   docker compose -f docker-compose.test.yml down -v
   ```

#### Opción C: PostgreSQL 16 Portable Nativo (Windows x64 sin Docker / S1.09)

Esta alternativa permite validar la persistencia real, las migraciones deterministas y el arranque del backend en equipos Windows donde Docker no esté disponible o la virtualización por hardware (Intel VT-x) no esté habilitada en la BIOS.

> [!NOTE]
> **Separación de Verificación de Entornos:**
> - **PostgreSQL 16 Nativo:** Verificado empíricamente con motor real en puerto 5433, migraciones aplicadas y comprobación nominal, degradada y de recuperación en `/health`.
> - **Docker / Docker Compose:** Los artefactos (`Dockerfile`, `docker-compose.yml`, `docker-compose.test.yml`) se encuentran implementados y listos, pero su ejecución en vivo en este host depende de habilitar Intel VT-x en la BIOS.

##### 1. Preparación del Entorno desde Cero (Reproducibilidad)

Si clonas el repositorio en un equipo limpio sin PostgreSQL instalado:

- **Instalación Automatizada (Recomendado):**
  ```powershell
  npm run db:test:setup
  ```
  *(Equivalente: `powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-test-db.ps1`)*

  **¿Qué realiza este script de forma segura y no destructiva?**
  1. Verifica si existen los binarios oficiales en `%LOCALAPPDATA%\Programs\pgsql\bin\postgres.exe`. Si no existen, descarga el paquete oficial de EnterpriseDB para Windows x64 (`postgresql-16.15-4-windows-x64-binaries.zip`) y lo extrae con `tar.exe`.
  2. Comprueba si el cluster `%LOCALAPPDATA%\Programs\pgsql\data_test` ya existe. Si la carpeta contiene datos no válidos, se detiene con error sin borrar nada accidentalmente. Si no existe, inicializa un cluster nuevo con `initdb.exe` utilizando cifrado `SCRAM-SHA-256`, locale `C`, codificación `UTF8` y el usuario `test_user`.
  3. Inicia temporalmente el motor con `pg_ctl.exe -w` en el puerto `5433` y ejecuta `createdb.exe` para crear la base `pelayodb_test`.
  4. Detiene el motor de forma controlada (`pg_ctl.exe -w stop`), dejando el cluster listo para su uso.

- **Instalación Manual Paso a Paso (Alternativa sin script):**
  Si prefieres ejecutar cada paso manualmente en PowerShell:
  ```powershell
  $pgDir = "$env:LOCALAPPDATA\Programs\pgsql"
  $dataDir = "$pgDir\data_test"

  # 1. Descargar y descomprimir binarios
  curl.exe -L -o "$env:TEMP\pgsql16.zip" "https://get.enterprisedb.com/postgresql/postgresql-16.15-4-windows-x64-binaries.zip"
  tar.exe -xf "$env:TEMP\pgsql16.zip" -C "$env:LOCALAPPDATA\Programs"

  # 2. Inicializar cluster de prueba
  $pwFile = "$env:TEMP\pg_pw.txt"
  Set-Content -Path $pwFile -Value "test_secret_isolated_pw" -NoNewline
  & "$pgDir\bin\initdb.exe" -D $dataDir -U test_user -A scram-sha-256 --pwfile=$pwFile -E UTF8 --locale=C
  Remove-Item $pwFile -Force

  # 3. Iniciar temporalmente y crear base de prueba
  & "$pgDir\bin\pg_ctl.exe" -D $dataDir -w -l "$pgDir\postgres_test.log" -o "-p 5433" start
  $env:PGPASSWORD = "test_secret_isolated_pw"
  & "$pgDir\bin\createdb.exe" -h localhost -p 5433 -U test_user pelayodb_test
  & "$pgDir\bin\pg_ctl.exe" -D $dataDir -w stop -m fast
  ```

##### 2. Iniciar el Motor de Pruebas
```bash
npm run db:test:start
```

##### 3. Aplicar Migraciones y Consultar Estado
Aplica las migraciones de forma determinista y consulta su estado apuntando al puerto 5433 sin modificar el archivo `.env`:

- En **PowerShell** (utiliza `try/finally` para garantizar la restauración de `$env:DATABASE_URL`):
  ```powershell
  $prevUrl = $env:DATABASE_URL
  try {
    $env:DATABASE_URL = "postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public"
    npm run prisma:deploy
    npm run prisma:status
  } finally {
    $env:DATABASE_URL = $prevUrl
  }
  ```

##### 4. Auditar Tablas Físicas con psql
Verifica directamente en PostgreSQL la existencia de `system_checks` y el registro de la migración:
```powershell
$env:PGPASSWORD = "test_secret_isolated_pw"
& "$env:LOCALAPPDATA\Programs\pgsql\bin\psql.exe" -h localhost -p 5433 -U test_user -d pelayodb_test -c "\dt" -c "SELECT id, migration_name, finished_at FROM _prisma_migrations;"
```

##### 5. Arrancar el Backend Conectado a la Base de Pruebas (Puerto 5433)
Para probar la aplicación ejecutándose en producción contra la base de datos de prueba (en el puerto HTTP `3001` y base `5433`):

- **Opción A (Script preconfigurado):**
  ```bash
  npm run start:test
  ```
  *Este comando inyecta `DATABASE_URL` hacia el puerto 5433 y `PORT=3001` sin alterar el archivo `.env`.*

- **Opción B (Manual en PowerShell):**
  ```powershell
  $prevUrl = $env:DATABASE_URL; $prevPort = $env:PORT
  try {
    $env:DATABASE_URL = "postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public"
    $env:PORT = "3001"
    $env:NODE_ENV = "production"
    node dist/main.js
  } finally {
    $env:DATABASE_URL = $prevUrl; $env:PORT = $prevPort
  }
  ```

- **Verificar la Salud de la Conexión (Health Check):**
  En otra terminal:
  ```bash
  curl http://localhost:3001/health
  ```
  Respuesta esperada (HTTP 200 OK):
  ```json
  {
    "status": "ok",
    "timestamp": "2026-09-21T21:00:00.000Z",
    "uptime": 3.45,
    "environment": "production",
    "services": {
      "database": "connected"
    }
  }
  ```

##### 6. Detener el Motor de Pruebas
```bash
npm run db:test:stop
```

##### 7. Verificación Automatizada Integral (Fail-Fast con Evidencia)
Se incluye un script de auditoría completa con aserciones estrictas que valida arranque, versión, migraciones, auditoría física con `psql`, arranque de backend en puerto 3001, healthcheck nominal (HTTP 200), conmutación de fallos ante caída de PostgreSQL (HTTP 503), recuperación automática (HTTP 200) y detención limpia exclusiva:

```bash
npm run test:verify:native
```
*Toda la evidencia de la auditoría se guarda en el archivo [`pelayo/s1-verification.log`](s1-verification.log).*

## 5. Ejecución de la Aplicación

### Modo Desarrollo (con recarga automática):
```bash
npm run start:dev
```

### Modo Producción:
```bash
npm run build
npm run start:prod
```

## 6. Verificación de Salud (Health Check)

Una vez iniciado el servidor, puedes comprobar el estado de salud del sistema y la conexión a la base de datos:

```bash
curl http://localhost:3000/health
```

Respuesta esperada (HTTP 200):
```json
{
  "status": "ok",
  "timestamp": "2026-09-21T18:40:00.000Z",
  "uptime": 12.34,
  "environment": "development",
  "services": {
    "database": "connected"
  }
}
```

## 7. Pruebas y Calidad de Código

Ejecutar pruebas unitarias:
```bash
npm run test
```

Ejecutar pruebas con reporte de cobertura:
```bash
npm run test:cov
```

Verificar y corregir formato con ESLint y Prettier:
```bash
npm run lint
npm run format
```

Compilar TypeScript:
```bash
npm run build
```

## 8. Integración WhatsApp Cloud API (Sprint 2)

El módulo `whatsapp` (`src/modules/whatsapp/`) gestiona el transporte oficial con la Cloud API de Meta (v21.0):

### 8.1 Endpoints del Webhook

- **GET `/api/v1/webhooks/whatsapp`**: Handshake y verificación de Meta.
  - Parámetros requeridos por Meta: `hub.mode=subscribe`, `hub.verify_token=<WHATSAPP_VERIFY_TOKEN>`, `hub.challenge=<string>`.
  - Responde: Código HTTP 200 con el string exacto de `hub.challenge`.
- **POST `/api/v1/webhooks/whatsapp`**: Recepción y procesamiento seguro de eventos.
  - **Seguridad**: Validado criptográficamente mediante cabecera `x-hub-signature-256: sha256=<hmac>` usando `WHATSAPP_APP_SECRET` y comparación segura en tiempo constante (`crypto.timingSafeEqual`).
  - **Deduplicación Atómica**: Clave única en PostgreSQL (`external_message_id`). Si Meta reintenta el mismo mensaje, se detecta de forma atómica (error `P2002`) sin reenviar respuestas ni duplicar registros.
  - **No-Texto / Multimedia**: Si el usuario envía audios, stickers, imágenes o documentos, se registran en `inbound_messages` con su tipo (`status: 'IGNORED'`) y se responde amablemente solicitando texto.
  - **Sanitización de Logs**: Nunca se registran tokens Bearer ni payloads crudos en consola o archivos.

### 8.2 Verificación Local de Resiliencia y Desacople

Para comprobar de forma aislada y determinista la persistencia en PostgreSQL, las migraciones, la seguridad HMAC-SHA256, el fail-fast con HTTP 500 ante fallos de base de datos, el desacople asíncrono no bloqueante (< 15ms) y la deduplicación atómica:

```bash
npm run test:verify:s2
```

La auditoría genera el archivo de evidencia [`pelayo/s2-verification.log`](s2-verification.log).

### 8.3 Demostración en Vivo con Meta Cloud API (S2.11)

Para acreditar el hito real de envío y recepción bidireccional contra los servidores de Meta Cloud API:

1. Configura credenciales reales en tu archivo `.env`:
   - `WHATSAPP_API_TOKEN`: Token de acceso generado en Meta for Developers.
   - `WHATSAPP_PHONE_NUMBER_ID`: ID del número de WhatsApp Business de prueba.
   - `DESTINATION_PHONE_NUMBER`: Tu número telefónico con código de país (ej. `56912345678`).
2. Ejecuta la prueba en vivo:
   ```bash
   npm run test:whatsapp:live
   ```
   La evidencia de la entrega real se registrará en `pelayo/s2-live-demo.log`.

### 8.4 Procedimiento Operativo: Revisión y Reprocesamiento de Eventos Abandonados (S2.09-B / S2.10-A)

Cuando un evento de estado de entrega de Meta (`WhatsAppStatusEvent`) no logra correlacionarse con ningún mensaje saliente o intento tras alcanzar su límite máximo de reintentos de reconciliación (`reconcileAttempts >= 5`), el reconciliador lo aparta defensivamente marcándolo como `abandoned = true`, preservando `reconciled = false` y registrando el motivo en `lastError`. Esto aísla el evento para evitar sobrecargar los ciclos de barrido periódicos.

#### 1. Consulta e Inspección de Eventos Abandonados
Para auditar eventos apartados sin alterar datos de producción:

```sql
-- Listar los últimos eventos abandonados no reconciliados
SELECT id, external_event_id, outbound_message_id, attempt_id, event_status, reconcile_attempts, last_error, received_at
FROM whatsapp_status_events
WHERE abandoned = true AND reconciled = false
ORDER BY received_at DESC
LIMIT 50;

-- Inspeccionar el payload original en JSON para diagnóstico
SELECT id, raw_payload
FROM whatsapp_status_events
WHERE id = '<UUID_DEL_EVENTO>';
```

#### 2. Procedimiento de Reprocesamiento Seguro
Si tras la revisión técnica se constata que el mensaje o intento ya existe (por ejemplo, retraso extremo en la recepción del webhook inicial o sincronización diferida):

```sql
-- Reactivar el evento para su reconciliación en el próximo ciclo del worker:
UPDATE whatsapp_status_events
SET abandoned = false,
    reconcile_attempts = 0,
    next_reconcile_at = NOW(),
    last_error = 'Reprocesamiento manual solicitado por operador'
WHERE id = '<UUID_DEL_EVENTO>'
  AND abandoned = true
  AND reconciled = false;
```

El reconciliador procesará el evento en su siguiente barrido periódico (`reconcilePendingEvents`) de forma idempotente, aplicando las reglas de transición atómica y verificación de intento vigente.

#### 3. Descarte Definitivo de Huérfanos
Si se confirma que el evento corresponde a tráfico sintético, pruebas antiguas o no posee correspondencia válida:

```sql
-- Cerrar el evento registrando la justificación del operador:
UPDATE whatsapp_status_events
SET last_error = 'Descartado manualmente: evento huerfano confirmado por operador'
WHERE id = '<UUID_DEL_EVENTO>'
  AND abandoned = true;
```

---

## 9. Estructura del Código

```text
src/
├── app.module.ts              # Módulo principal de la aplicación
├── main.ts                    # Punto de entrada y bootstrap (rawBody: true)
├── common/                    # Utilidades comunes transversales
│   ├── config/                # Validación estricta de entorno con Zod
│   └── logging/               # Logger estructurado con redacción de secretos
├── infrastructure/            # Adaptadores e infraestructura técnica
│   └── prisma/                # Servicio y ciclo de vida de conexión PostgreSQL
└── modules/                   # Módulos organizados por dominio
    ├── health/                # Endpoint de salud y diagnóstico
    ├── whatsapp/              # [Sprint 2] Transporte, Guard HMAC, Adapter Meta y Deduplicación
    │   ├── whatsapp.types.ts
    │   ├── whatsapp-signature.guard.ts
    │   ├── whatsapp-sender.adapter.ts
    │   ├── whatsapp.service.ts
    │   ├── whatsapp.controller.ts
    │   └── whatsapp.module.ts
    ├── conversations/         # [Sprints 3 y 6] Persistencia y FSM
    ├── customers/             # [Sprint 3] Clientes
    ├── vehicles/              # [Sprint 4] Inventario y búsqueda
    ├── documents/             # [Sprint 5] Autofact y Storage privado
    └── appointments/          # [Sprint 7] Citas y Agenda
```

