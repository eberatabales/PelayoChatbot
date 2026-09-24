const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const logFile = path.resolve(rootDir, 's1-verification.log');
const pgDir = path.join(process.env.LOCALAPPDATA, 'Programs/pgsql');
const pgBin = path.join(pgDir, 'bin');
const dataDir = path.join(pgDir, 'data_test');
const pgCtl = path.join(pgBin, 'pg_ctl.exe');
const psql = path.join(pgBin, 'psql.exe');
const testDbUrl = 'postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public';
const prismaCli = path.join(rootDir, 'node_modules/prisma/build/index.js');

const nodeDir = path.dirname(process.execPath);
process.env.PATH = `${nodeDir};${pgBin};${process.env.PATH || ''}`;

let backendProcess = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logFile, line, 'utf8');
}

function logSection(title) {
  const line = `\n================================================================================\n${title}\n================================================================================\n`;
  process.stdout.write(line);
  fs.appendFileSync(logFile, line, 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    const errorMsg = `[ERROR DE ASERCION] ${message}`;
    log(errorMsg);
    throw new Error(errorMsg);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup() {
  if (backendProcess && backendProcess.exitCode === null) {
    try {
      spawnSync('taskkill', ['/pid', backendProcess.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
      log(`Backend de prueba PID ${backendProcess.pid} detenido.`);
    } catch {}
  }
  try {
    spawnSync(pgCtl, ['-D', dataDir, '-w', '-m', 'fast', 'stop'], { stdio: 'ignore' });
    log('PostgreSQL de prueba detenido limpiamente.');
  } catch {}
}

async function main() {
  fs.writeFileSync(logFile, '', 'utf8');

  logSection('PELAYOBOT - REPORTE DE VERIFICACION SPRINT 1 (POSTGRESQL 16 NATIVO)');
  log(`Node: ${process.version} (${process.execPath})`);
  log(`Plataforma: ${process.platform} ${process.arch}`);
  log(`Base de datos destino: ${testDbUrl.replace(/:[^:@]+@/, ':***@')}`);

  // 1. Asegurar arranque de PostgreSQL 16 en puerto 5433
  logSection('1. ARRANQUE DE POSTGRESQL 16 EN PUERTO 5433');
  const statusCheck = spawnSync(pgCtl, ['-D', dataDir, 'status'], { encoding: 'utf8' });
  if (statusCheck.status !== 0) {
    const startRes = spawnSync(pgCtl, ['-D', dataDir, '-w', '-l', path.join(pgDir, 'postgres_test.log'), '-o', '-p 5433', 'start'], { stdio: 'ignore' });
    assert(startRes.status === 0, 'No fue posible iniciar el servicio PostgreSQL 16 en puerto 5433.');
    log('Servidor PostgreSQL iniciado en puerto 5433.');
  } else {
    log('PostgreSQL ya se encontraba activo en puerto 5433.');
  }

  // 2. Consulta de versión con psql
  logSection('2. CONSULTA DE VERSION DE POSTGRESQL (psql)');
  const verRes = spawnSync(psql, ['-h', 'localhost', '-p', '5433', '-U', 'test_user', '-d', 'pelayodb_test', '-c', 'SELECT version();'], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: 'test_secret_isolated_pw' },
  });
  assert(verRes.status === 0, `Fallo psql SELECT version(): ${verRes.stderr}`);
  const versionOutput = (verRes.stdout || '').trim();
  assert(versionOutput.includes('PostgreSQL 16'), 'Version no corresponde a PostgreSQL 16.');
  log(versionOutput);

  // 3. Aplicación de migraciones con Prisma
  logSection('3. APLICACION DETERMINISTA DE MIGRACIONES (prisma migrate deploy)');
  const deployRes = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testDbUrl },
  });
  assert(deployRes.status === 0, `Fallo prisma migrate deploy: ${deployRes.stderr || deployRes.stdout}`);
  const deployOutput = ((deployRes.stdout || '') + (deployRes.stderr || '')).trim();
  log(deployOutput);

  // 4. Estado de migraciones Prisma
  logSection('4. ESTADO DE MIGRACIONES PRISMA (prisma migrate status)');
  const statusRes = spawnSync(process.execPath, [prismaCli, 'migrate', 'status'], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testDbUrl },
  });
  assert(statusRes.status === 0, `Fallo prisma migrate status: ${statusRes.stderr || statusRes.stdout}`);
  const statusOutput = ((statusRes.stdout || '') + (statusRes.stderr || '')).trim();
  assert(statusOutput.includes('Database schema is up to date!'), 'El esquema Prisma no esta al dia.');
  log(statusOutput);

  // 5. Auditoría física de tablas con psql
  logSection('5. AUDITORIA FISICA EN BASE DE DATOS (psql \\dt y _prisma_migrations)');
  const auditRes = spawnSync(psql, ['-h', 'localhost', '-p', '5433', '-U', 'test_user', '-d', 'pelayodb_test', '-c', '\\dt', '-c', 'SELECT id, migration_name, finished_at, rolled_back_at FROM _prisma_migrations;'], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: 'test_secret_isolated_pw' },
  });
  assert(auditRes.status === 0, `Fallo auditoria psql: ${auditRes.stderr}`);
  const auditOutput = (auditRes.stdout || '').trim();
  assert(auditOutput.includes('system_checks'), "Tabla 'system_checks' no encontrada.");
  assert(auditOutput.includes('_prisma_migrations'), "Tabla '_prisma_migrations' no encontrada.");
  assert(auditOutput.includes('20260921000000_init_system_check'), 'Registro de migracion inicial no encontrado.');
  log(auditOutput);

  // 6. Arranque del Backend NestJS en puerto 3001
  logSection('6. ARRANQUE DEL BACKEND EN PUERTO 3001');

  // Asegurar que el puerto 3001 NO este previamente ocupado por otro servidor
  try {
    const preCheck = await fetch('http://localhost:3001/health', { signal: AbortSignal.timeout(800) });
    if (preCheck) {
      throw new Error('El puerto 3001 ya se encuentra ocupado por otro proceso. Detengalo antes de verificar.');
    }
  } catch (err) {
    if (err.message.includes('El puerto 3001 ya se encuentra ocupado')) {
      throw err;
    }
    // Si la conexión fue rechazada, el puerto está disponible para la prueba.
  }

  const stdoutLog = path.resolve(rootDir, 'backend-stdout.log');
  const stderrLog = path.resolve(rootDir, 'backend-stderr.log');
  fs.writeFileSync(stdoutLog, '', 'utf8');
  fs.writeFileSync(stderrLog, '', 'utf8');

  backendProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '3001',
      DATABASE_URL: testDbUrl,
    },
    stdio: ['ignore', fs.openSync(stdoutLog, 'a'), fs.openSync(stderrLog, 'a')],
  });

  await sleep(4000);

  // Comprobar que el proceso sigue vivo y no termino con error
  assert(backendProcess.exitCode === null, `El backend termino prematuramente con codigo de salida ${backendProcess.exitCode}.`);

  // Comprobar la salida del backend para certificar que el proceso iniciado arranco efectivamente
  const stdoutContent = fs.readFileSync(stdoutLog, 'utf8');
  assert(
    stdoutContent.includes('PelayoBot iniciado exitosamente en http://localhost:3001'),
    'El backend no registro el mensaje de bootstrap esperado en su log de salida.'
  );
  log(`Backend iniciado y verificado en ejecucion con PID especifico: ${backendProcess.pid}`);

  // 7. Healthcheck nominal (HTTP 200 OK)
  logSection('7. COMPROBACION NOMINAL DE SALUD (GET /health -> HTTP 200)');
  assert(backendProcess.exitCode === null, 'El backend murio antes del healthcheck nominal.');
  const nominalRes = await fetch('http://localhost:3001/health');
  assert(nominalRes.status === 200, `Healthcheck nominal retorno HTTP ${nominalRes.status} (esperado 200)`);
  const nominalBody = await nominalRes.json();
  assert(nominalBody.status === 'ok', "Healthcheck status nominal no es 'ok'");
  assert(nominalBody.services?.database === 'connected', "Servicio database no esta 'connected'");
  log(`HTTP Status: ${nominalRes.status} OK`);
  log(`Body: ${JSON.stringify(nominalBody)}`);

  // 8. Conmutación de fallo: Detener PostgreSQL
  logSection('8. PRUEBA DE CONMUTACION DE FALLO (PostgreSQL detenido -> HTTP 503)');
  const stopRes = spawnSync(pgCtl, ['-D', dataDir, '-w', '-m', 'fast', 'stop'], { stdio: 'ignore' });
  assert(stopRes.status === 0, 'Fallo al detener PostgreSQL de forma controlada.');
  log('Servidor PostgreSQL detenido de forma controlada.');
  await sleep(2000);

  assert(backendProcess.exitCode === null, 'El backend murio tras la detencion de la base de datos.');
  const degradedRes = await fetch('http://localhost:3001/health');
  assert(degradedRes.status === 503, `Healthcheck con BD caida retorno HTTP ${degradedRes.status} (esperado 503)`);
  const degradedBody = await degradedRes.json();
  assert(degradedBody.status === 'degraded', "Healthcheck status no es 'degraded'");
  assert(degradedBody.services?.database === 'disconnected', "Servicio database no es 'disconnected'");
  log(`HTTP Status: ${degradedRes.status} Service Unavailable`);
  log(`Body: ${JSON.stringify(degradedBody)}`);

  // 9. Recuperación: Reanudar PostgreSQL
  logSection('9. RECUPERACION AUTOMATICA (PostgreSQL reanudado -> HTTP 200)');
  const restartRes = spawnSync(pgCtl, ['-D', dataDir, '-w', '-l', path.join(pgDir, 'postgres_test.log'), '-o', '-p 5433', 'start'], { stdio: 'ignore' });
  assert(restartRes.status === 0, 'Fallo al reanudar PostgreSQL en puerto 5433.');
  log('Servidor PostgreSQL reanudado y aceptando conexiones.');

  let recovered = false;
  let recoveredBody = null;
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    assert(backendProcess.exitCode === null, 'El backend murio durante la fase de recuperacion.');
    try {
      const res = await fetch('http://localhost:3001/health');
      if (res.status === 200) {
        recoveredBody = await res.json();
        if (recoveredBody.status === 'ok' && recoveredBody.services?.database === 'connected') {
          recovered = true;
          log(`Intento ${i + 1} - Recuperacion confirmada: HTTP 200 OK`);
          log(`Body: ${JSON.stringify(recoveredBody)}`);
          break;
        }
      }
    } catch {}
  }
  assert(recovered, 'El endpoint /health no se recupero a HTTP 200 tras reanudar PostgreSQL en el tiempo esperado.');

  // 10. Resumen de auditoría exitosa
  logSection('RESULTADO FINAL (TODAS LAS ASERCIONES VERIFICADAS EXITOSAMENTE)');
  log('- PostgreSQL 16 nativo en puerto 5433: VERIFICADO Y OPERATIVO');
  log('- Migraciones Prisma aplicadas: VERIFICADO (determinista)');
  log('- Tablas fisicas y _prisma_migrations: VERIFICADO CON PSQL');
  log('- Healthcheck nominal (HTTP 200, connected): VERIFICADO');
  log('- Healthcheck fallo (HTTP 503, disconnected): VERIFICADO');
  log('- Healthcheck recuperacion (HTTP 200, connected): VERIFICADO');
  log(`Reporte guardado en: ${logFile}`);
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    log(`ERROR FATAL EN LA AUDITORIA: ${err.message}`);
    cleanup();
    process.exit(1);
  });
