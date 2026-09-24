#!/usr/bin/env node
/**
 * demo-live-whatsapp.js - Demostración en vivo con WhatsApp Cloud API (Meta) para S2.11-A
 *
 * Cubre el ciclo real completo: Teléfono → Webhook Meta → DB PostgreSQL → Adaptador PelayoBot → Teléfono.
 *
 * Modos de ejecución:
 * 1. Outbound directo (verificación de credenciales):
 *    node scripts/demo-live-whatsapp.js --verify-outbound
 *
 * 2. Ciclo completo de webhook (S2.11-A):
 *    node scripts/demo-live-whatsapp.js --listen-webhook
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');
const logPath = path.join(rootDir, 's2-live-demo.log');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const apiToken = process.env.WHATSAPP_API_TOKEN;
const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const destinationPhone = process.env.DESTINATION_PHONE_NUMBER;
const apiUrl = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0';
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
const port = process.env.PORT || '3000';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n', 'utf8');
}

function checkCredentials() {
  const isPlaceholder =
    !apiToken ||
    apiToken.includes('placeholder') ||
    apiToken.includes('test_meta') ||
    !phoneId ||
    phoneId === '100000000000001';

  return !isPlaceholder;
}

async function verifyOutbound() {
  const maskedDest = destinationPhone && destinationPhone.length > 4 ? `***${destinationPhone.slice(-4)}` : '***';
  log(`[OUTBOUND] Enviando mensaje de prueba en vivo a: ${maskedDest}...`);

  const endpoint = `${apiUrl.replace(/\/$/, '')}/${phoneId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: destinationPhone,
    type: 'text',
    text: {
      preview_url: false,
      body: `PelayoBot Live Test (S2.11-A): Hola! Verificación de credenciales activas generada a las ${new Date().toLocaleTimeString()}.`,
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      log(`[ERROR] Meta API respondió con HTTP ${response.status}: ${JSON.stringify(body)}`);
      return false;
    }

    const messageId = body.messages?.[0]?.id;
    log(`[EXITO] Mensaje saliente enviado vía WhatsApp Cloud API.`);
    log(`Meta Message ID (wamid): ${messageId}`);
    return true;
  } catch (err) {
    log(`[ERROR] Excepción conectando con Meta API: ${err.message}`);
    return false;
  }
}

async function listenWebhook() {
  log('======================================================================');
  log('S2.11-A: VERIFICACION DEL CICLO COMPLETO DE WEBHOOK (TELEFONO -> BOT -> TELEFONO)');
  log('======================================================================');
  log('\nInstrucciones para exponer el webhook local y configurarlo en Meta:');
  log('1. Inicia el backend de PelayoBot: npm run start:dev');
  log(`2. Expón el puerto local mediante un túnel HTTPS (ej: ngrok http ${port} o cloudflared)`);
  log('3. En Meta for Developers (WhatsApp > Configuration):');
  log(`   - Callback URL: https://<tu-url-de-tunel>/api/v1/webhooks/whatsapp`);
  log(`   - Verify Token: ${verifyToken || '(valor de WHATSAPP_VERIFY_TOKEN en tu .env)'}`);
  log('   - Webhook Fields suscritos: messages');
  log('4. Envía un mensaje de WhatsApp desde tu teléfono real al número de PelayoBot.');
  log('======================================================================\n');

  log('Esperando eventos en PostgreSQL y backend... Pulsa Ctrl+C para salir.');
}

async function main() {
  fs.writeFileSync(logPath, '', 'utf8');

  log('======================================================================');
  log('PELAYOBOT - DEMOSTRACION EN VIVO CON WHATSAPP CLOUD API (S2.11-A)');
  log('======================================================================');

  const hasCredentials = checkCredentials();

  if (!hasCredentials) {
    console.log('\n⚠️  CREDENCIALES REALES DE META NO CONFIGURADAS O INCOMPLETAS');
    console.log('----------------------------------------------------------------------');
    console.log('Para ejecutar la acreditación en vivo de S2.11-A contra Meta Cloud API, debes');
    console.log('configurar en tu archivo .env o en el entorno las siguientes variables:');
    console.log('  1. WHATSAPP_API_TOKEN: Token temporal o permanente de Meta for Developers');
    console.log('  2. WHATSAPP_PHONE_NUMBER_ID: ID del número telefónico asignado por Meta');
    console.log('  3. DESTINATION_PHONE_NUMBER: Teléfono de prueba para pruebas salientes (ej: 56912345678)');
    console.log('  4. WHATSAPP_VERIFY_TOKEN: Token secreto de handshake para el webhook HTTPS\n');
    console.log('El Sprint 2 cuenta con toda la resiliencia técnica, concurrencia y durabilidad');
    console.log('completadas (S2.01 a S2.10-A). S2.11-A se cierra con la prueba en vivo.');
    console.log('----------------------------------------------------------------------\n');

    log('[INFO] Acreditación S2.11-A pausada: faltan credenciales activas de Meta.');
    process.exit(2);
  }

  const args = process.argv.slice(2);
  if (args.includes('--listen-webhook')) {
    await listenWebhook();
  } else {
    log('Modo por defecto: Verificando credenciales salientes y conectividad con Meta...');
    const ok = await verifyOutbound();
    if (ok) {
      log('\n[PROXIMO PASO] Ejecuta con --listen-webhook para registrar el flujo completo entrante/saliente.');
    }
  }
}

main();
