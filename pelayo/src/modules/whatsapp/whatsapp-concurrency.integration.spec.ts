const TEST_DB_URL =
  'postgresql://test_user:test_secret_isolated_pw@localhost:5433/pelayodb_test?schema=public';
process.env.DATABASE_URL = TEST_DB_URL;

import { AppLogger } from '../../common/logging/logger.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor';
import { WhatsAppSenderAdapter } from './whatsapp-sender.adapter';
import { WhatsAppStatusReconcilerService } from './whatsapp-status-reconciler.service';

describe('WhatsApp Real Concurrency Integration (PostgreSQL 16)', () => {
  let prisma: PrismaService;
  let mockSenderAdapter: Partial<WhatsAppSenderAdapter>;
  let mockLogger: Partial<AppLogger>;
  let statusReconciler: WhatsAppStatusReconcilerService;
  let worker1: WhatsAppQueueProcessor;
  let worker2: WhatsAppQueueProcessor;

  const TEST_PREFIX = `wamid.INT_TEST_CONC_${Date.now()}`;

  beforeAll(async () => {
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    prisma = new PrismaService(mockLogger as AppLogger, {
      datasourceUrl: TEST_DB_URL,
    });
    await prisma.$connect();
    statusReconciler = new WhatsAppStatusReconcilerService(prisma, mockLogger as AppLogger);
  });

  afterAll(async () => {
    // Limpieza estricta de registros de prueba
    if (prisma) {
      await prisma.whatsAppStatusEvent.deleteMany({
        where: {
          statusId: { startsWith: `status_${TEST_PREFIX}` },
        },
      });
      await prisma.whatsAppSendAttempt.deleteMany({
        where: {
          inboundMessage: {
            externalMessageId: { startsWith: TEST_PREFIX },
          },
        },
      });
      await prisma.inboundMessage.deleteMany({
        where: {
          externalMessageId: { startsWith: TEST_PREFIX },
        },
      });
      await prisma.$disconnect();
    }
  });

  beforeEach(() => {
    mockSenderAdapter = {
      sendTextMessage: jest.fn().mockImplementation(async (_phone: string, _text: string) => {
        // Simular latencia de red de 20ms con Meta API
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          success: true,
          messageId: `wamid.META_RESPONSE_${Date.now()}_${Math.random()}`,
        };
      }),
    };

    worker1 = new WhatsAppQueueProcessor(
      prisma,
      mockSenderAdapter as WhatsAppSenderAdapter,
      statusReconciler,
      mockLogger as AppLogger,
    );

    worker2 = new WhatsAppQueueProcessor(
      prisma,
      mockSenderAdapter as WhatsAppSenderAdapter,
      statusReconciler,
      mockLogger as AppLogger,
    );
  });

  afterEach(() => {
    worker1?.stopWorker();
    worker2?.stopWorker();
  });

  it('dos workers compitiendo por el mismo registro en PostgreSQL ejecutan exactamente un solo envío', async () => {
    const extId = `${TEST_PREFIX}_001`;

    // 1. Insertar registro real en PostgreSQL en estado RECEIVED
    const msg = await prisma.inboundMessage.create({
      data: {
        externalMessageId: extId,
        fromPhone: '56912345678',
        messageType: 'text',
        content: 'Consulta de stock concurrente real',
        status: 'RECEIVED',
        rawPayload: { text: { body: 'Consulta de stock concurrente real' } },
      },
    });

    // 2. Disparar simultáneamente worker1 y worker2 contra el mismo ID
    const [res1, res2] = await Promise.all([
      worker1.processRecord(msg.id),
      worker2.processRecord(msg.id),
    ]);

    // Exactamente uno gana y el otro pierde el reclamo atómico
    const results = [res1, res2];
    const winners = results.filter((r) => r === true);
    const losers = results.filter((r) => r === false);

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    // Verificación estricta: exactamente UNA sola llamada al adaptador Meta
    expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(1);

    // 3. Inspeccionar el estado final persistido en PostgreSQL
    const updated = await prisma.inboundMessage.findUnique({
      where: { id: msg.id },
      include: { sendAttempts: true },
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('PROCESSED');
    expect(updated?.responseSent).toBe(true);
    expect(updated?.outboundMessageId).toBeDefined();
    expect(updated?.claimToken).toBeDefined();
    expect(updated?.attempts).toBe(1);

    // Exactamente 1 intento de envío persistido en whatsAppSendAttempt
    expect(updated?.sendAttempts.length).toBe(1);
    expect(updated?.sendAttempts[0].status).toBe('ACCEPTED');
    expect(updated?.sendAttempts[0].outboundMessageId).toBe(updated?.outboundMessageId);
  });

  it('múltiples workers compitiendo por un lote procesan cada mensaje exactamente una vez sin duplicados', async () => {
    const batchCount = 5;
    const records = [];

    for (let i = 0; i < batchCount; i++) {
      const rec = await prisma.inboundMessage.create({
        data: {
          externalMessageId: `${TEST_PREFIX}_BATCH_${i}`,
          fromPhone: `5691111222${i}`,
          messageType: 'text',
          content: `Mensaje de lote ${i}`,
          status: 'RECEIVED',
          rawPayload: {},
        },
      });
      records.push(rec);
    }

    // 3 workers concurrentes compitiendo por todos los registros del lote
    const worker3 = new WhatsAppQueueProcessor(
      prisma,
      mockSenderAdapter as WhatsAppSenderAdapter,
      statusReconciler,
      mockLogger as AppLogger,
    );

    const workers = [worker1, worker2, worker3];

    // Lanzar procesamiento cruzado simultáneo
    const promises: Promise<boolean>[] = [];
    for (const rec of records) {
      for (const w of workers) {
        promises.push(w.processRecord(rec.id));
      }
    }

    const allResults = await Promise.all(promises);
    worker3.stopWorker();

    // De las 15 ejecuciones (5 registros x 3 workers), exactamente 5 deben haber sido procesadas (1 por mensaje)
    const successCount = allResults.filter((r) => r === true).length;
    expect(successCount).toBe(batchCount);

    // Exactamente batchCount llamadas al adaptador
    expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(batchCount);

    // Comprobar en PostgreSQL que todos los 5 registros están en PROCESSED
    const dbRecords = await prisma.inboundMessage.findMany({
      where: {
        externalMessageId: { startsWith: `${TEST_PREFIX}_BATCH_` },
      },
      include: { sendAttempts: true },
    });

    expect(dbRecords.length).toBe(batchCount);
    for (const rec of dbRecords) {
      expect(rec.status).toBe('PROCESSED');
      expect(rec.responseSent).toBe(true);
      expect(rec.sendAttempts.length).toBe(1);
      expect(rec.sendAttempts[0].status).toBe('ACCEPTED');
    }
  });

  it('dos mensajes simultáneos del mismo teléfono se reconcilian independientemente por opaque_callback_data', async () => {
    const phone = '56988887777';

    // 1. Crear dos mensajes concurrentes del mismo teléfono
    const msgA = await prisma.inboundMessage.create({
      data: {
        externalMessageId: `${TEST_PREFIX}_TWO_A`,
        fromPhone: phone,
        messageType: 'text',
        content: 'Pregunta A',
        status: 'UNCERTAIN',
        attempts: 1, // Invariante: el intento 1 fue ejecutado
        deliveryUncertain: true,
        rawPayload: {},
      },
    });

    const msgB = await prisma.inboundMessage.create({
      data: {
        externalMessageId: `${TEST_PREFIX}_TWO_B`,
        fromPhone: phone,
        messageType: 'text',
        content: 'Pregunta B',
        status: 'UNCERTAIN',
        attempts: 1, // Invariante: el intento 1 fue ejecutado
        deliveryUncertain: true,
        rawPayload: {},
      },
    });

    // 2. Crear un WhatsAppSendAttempt para A y otro para B
    const attemptA = await prisma.whatsAppSendAttempt.create({
      data: {
        inboundMessageId: msgA.id,
        attemptNumber: 1,
        claimToken: 'token-A',
        status: 'INITIATED',
        outboundMessageId: `${TEST_PREFIX}_OUT_A`,
      },
    });

    await prisma.whatsAppSendAttempt.create({
      data: {
        inboundMessageId: msgB.id,
        attemptNumber: 1,
        claimToken: 'token-B',
        status: 'INITIATED',
        outboundMessageId: `${TEST_PREFIX}_OUT_B`,
      },
    });

    // 3. Simular webhook de Meta con status report para A que incluye biz_opaque_callback_data = attemptA.id
    const reconciled = await statusReconciler.ingestAndReconcile({
      id: `${TEST_PREFIX}_OUT_A`,
      status: 'delivered',
      timestamp: String(Math.floor(Date.now() / 1000)),
      recipient_id: phone,
      biz_opaque_callback_data: attemptA.id,
    });

    expect(reconciled).toBe(true);

    // 4. Verificar que mensaje A fue reconciliado a PROCESSED
    const updatedA = await prisma.inboundMessage.findUnique({ where: { id: msgA.id } });
    expect(updatedA?.status).toBe('PROCESSED');
    expect(updatedA?.deliveryUncertain).toBe(false);

    // 5. Verificación crítica: Mensaje B PERMANECE en UNCERTAIN, jamás fue falsamente marcado por compartir teléfono
    const updatedB = await prisma.inboundMessage.findUnique({ where: { id: msgB.id } });
    expect(updatedB?.status).toBe('UNCERTAIN');
    expect(updatedB?.deliveryUncertain).toBe(true);
  });

  it('un mensaje en FAILED_FINAL es ignorado por los workers y jamás se reenvía', async () => {
    const extId = `${TEST_PREFIX}_FAILED_FINAL`;

    const fatalMsg = await prisma.inboundMessage.create({
      data: {
        externalMessageId: extId,
        fromPhone: '56933334444',
        messageType: 'text',
        content: 'Mensaje que falló terminalmente',
        status: 'FAILED_FINAL',
        nextRetryAt: null,
        rawPayload: {},
      },
    });

    // Worker intenta procesar
    const result = await worker1.processRecord(fatalMsg.id);

    // Reclamo falló porque FAILED_FINAL no califica
    expect(result).toBe(false);
    expect(mockSenderAdapter.sendTextMessage).not.toHaveBeenCalled();

    // Estado sigue siendo FAILED_FINAL
    const fresh = await prisma.inboundMessage.findUnique({ where: { id: fatalMsg.id } });
    expect(fresh?.status).toBe('FAILED_FINAL');
  });

  it('ejecución simultánea de delivered y failed contra PostgreSQL mantiene mensaje e intento estrictamente coherentes', async () => {
    const extId = `${TEST_PREFIX}_DELIV_VS_FAILED`;
    const outboundId = `${TEST_PREFIX}_OUT_RACE`;

    const msg = await prisma.inboundMessage.create({
      data: {
        externalMessageId: extId,
        fromPhone: '56944445555',
        messageType: 'text',
        content: 'Prueba carrera delivered vs failed',
        status: 'SENDING',
        attempts: 1,
        maxAttempts: 3,
        rawPayload: {},
      },
    });

    const attempt = await prisma.whatsAppSendAttempt.create({
      data: {
        inboundMessageId: msg.id,
        attemptNumber: 1,
        claimToken: 'token-race-1',
        status: 'INITIATED',
        outboundMessageId: outboundId,
      },
    });

    // Ejecutar simultáneamente webhook delivered y webhook failed sobre el mismo intento
    const [resDelivered, resFailed] = await Promise.all([
      statusReconciler.ingestAndReconcile({
        id: outboundId,
        status: 'delivered',
        timestamp: String(Math.floor(Date.now() / 1000)),
        recipient_id: '56944445555',
        biz_opaque_callback_data: attempt.id,
      }),
      statusReconciler.ingestAndReconcile({
        id: outboundId,
        status: 'failed',
        timestamp: String(Math.floor(Date.now() / 1000) + 1),
        recipient_id: '56944445555',
        biz_opaque_callback_data: attempt.id,
        errors: [{ code: 131026, title: 'Undeliverable' }],
      }),
    ]);

    expect(resDelivered).toBe(true);
    expect(resFailed).toBe(true);

    const freshMsg = await prisma.inboundMessage.findUnique({ where: { id: msg.id } });
    const freshAttempt = await prisma.whatsAppSendAttempt.findUnique({ where: { id: attempt.id } });

    // Verificación de coherencia estricta:
    // Si la entrega física fue confirmada (DELIVERED), el mensaje NUNCA debe quedar en FAILED_FINAL o RETRY_PENDING.
    // O si failed ganó antes de que delivered llegara, ambos deben reflejar falla.
    if (freshAttempt?.status === 'DELIVERED') {
      expect(freshMsg?.status).toBe('PROCESSED');
      expect(freshMsg?.deliveryUncertain).toBe(false);
    } else if (freshAttempt?.status === 'FATAL_FAILURE') {
      expect(freshMsg?.status).toBe('FAILED_FINAL');
      expect(freshMsg?.deliveryUncertain).toBe(false);
    } else {
      expect(['DELIVERED', 'READ']).toContain(freshAttempt?.status);
      expect(freshMsg?.status).toBe('PROCESSED');
    }
  });

  it('sent atrasado de A mientras B está en SENDING en PostgreSQL: no marca B como procesado ni reemplaza su ID', async () => {
    const extId = `${TEST_PREFIX}_DELAYED_SENT_A`;
    const outboundA = `${TEST_PREFIX}_OUT_A_LATE`;
    const outboundB = `${TEST_PREFIX}_OUT_B_ACTIVE`;

    // 1. Mensaje en SENDING tras crearse el intento B (#2)
    const msg = await prisma.inboundMessage.create({
      data: {
        externalMessageId: extId,
        fromPhone: '56955556666',
        messageType: 'text',
        content: 'Prueba sent atrasado de A',
        status: 'SENDING',
        attempts: 2,
        maxAttempts: 3,
        outboundMessageId: outboundB,
        rawPayload: {},
      },
    });

    // Intento A (#1) que falló transitoriamente
    const attemptA = await prisma.whatsAppSendAttempt.create({
      data: {
        inboundMessageId: msg.id,
        attemptNumber: 1,
        claimToken: 'token-A-old',
        status: 'RETRYABLE_REJECTION',
        outboundMessageId: outboundA,
      },
    });

    // Intento B (#2) actualmente en vuelo (INITIATED / SENDING)
    const attemptB = await prisma.whatsAppSendAttempt.create({
      data: {
        inboundMessageId: msg.id,
        attemptNumber: 2,
        claimToken: 'token-B-current',
        status: 'INITIATED',
        outboundMessageId: outboundB,
      },
    });

    // 2. Llega un webhook 'sent' atrasado correspondiente al intento A (#1)
    const reconciled = await statusReconciler.ingestAndReconcile({
      id: outboundA,
      status: 'sent',
      timestamp: String(Math.floor(Date.now() / 1000)),
      recipient_id: '56955556666',
      biz_opaque_callback_data: attemptA.id,
    });

    expect(reconciled).toBe(true);

    // 3. Verificaciones estrictas contra PostgreSQL real:
    const freshMsg = await prisma.inboundMessage.findUnique({
      where: { id: msg.id },
    });
    const freshAttemptB = await prisma.whatsAppSendAttempt.findUnique({
      where: { id: attemptB.id },
    });

    // El mensaje B NO fue marcado como PROCESSED, sigue en SENDING
    expect(freshMsg?.status).toBe('SENDING');
    // El outboundMessageId del mensaje NO fue reemplazado con el de A
    expect(freshMsg?.outboundMessageId).toBe(outboundB);
    // El intento B sigue en su estado de vuelo
    expect(freshAttemptB?.status).toBe('INITIATED');
    // El intento A no contaminó el mensaje
    expect(freshMsg?.attempts).toBe(2);
  });

  it('creación de B simultánea al procesamiento de un evento de A en PostgreSQL: el evento antiguo no altera el estado de B', async () => {
    const extId = `${TEST_PREFIX}_CONC_RACE_AB`;
    const outboundA = `${TEST_PREFIX}_OUT_RACE_A`;

    // 1. Mensaje en RETRY_PENDING listo para su segundo intento
    const msg = await prisma.inboundMessage.create({
      data: {
        externalMessageId: extId,
        fromPhone: '56966667777',
        messageType: 'text',
        content: 'Prueba carrera creación B vs reconciliación A',
        status: 'RETRY_PENDING',
        attempts: 1,
        maxAttempts: 3,
        nextRetryAt: new Date(Date.now() - 5000), // Ya venció backoff, elegible para worker
        outboundMessageId: null,
        rawPayload: {},
      },
    });

    const attemptA = await prisma.whatsAppSendAttempt.create({
      data: {
        inboundMessageId: msg.id,
        attemptNumber: 1,
        claimToken: 'token-race-A',
        status: 'INITIATED',
        outboundMessageId: outboundA,
      },
    });

    // 2. Disparar simultáneamente:
    // - El worker que reclama el mensaje y crea el intento B (#2)
    // - El reconciliador procesando un evento de estado para el intento A (#1)
    const [workerResult, reconcilerResult] = await Promise.all([
      worker1.processRecord(msg.id),
      statusReconciler.ingestAndReconcile({
        id: outboundA,
        status: 'sent',
        timestamp: String(Math.floor(Date.now() / 1000)),
        recipient_id: '56966667777',
        biz_opaque_callback_data: attemptA.id,
      }),
    ]);

    expect(workerResult).toBe(true);
    expect(reconcilerResult).toBe(true);

    const freshMsg = await prisma.inboundMessage.findUnique({ where: { id: msg.id } });
    const allAttempts = await prisma.whatsAppSendAttempt.findMany({
      where: { inboundMessageId: msg.id },
      orderBy: { attemptNumber: 'asc' },
    });

    // Verificación de aislamiento estricto:
    // Debe existir intento B (#2)
    expect(allAttempts.length).toBe(2);
    const attemptB = allAttempts[1];
    expect(attemptB.attemptNumber).toBe(2);

    // El mensaje debe reflejar el intento B (#2):
    expect(freshMsg?.attempts).toBe(2);
    // El outboundMessageId del mensaje debe ser el de B (generado por el worker), NUNCA el de A
    expect(freshMsg?.outboundMessageId).not.toBe(outboundA);
    expect(freshMsg?.outboundMessageId).toBe(attemptB.outboundMessageId);
  });

  it('reintento completo tras fallo transitorio en PostgreSQL: genera intento 2, envía al adaptador y confirma PROCESSED', async () => {
    const extId = `${TEST_PREFIX}_FULL_RETRY_CYCLE`;
    const outbound1 = `${TEST_PREFIX}_OUT_FIRST`;

    // 1. Mensaje nuevo en RECEIVED
    const msg = await prisma.inboundMessage.create({
      data: {
        externalMessageId: extId,
        fromPhone: '56977778888',
        messageType: 'text',
        content: 'Ciclo completo de reintento real',
        status: 'RECEIVED',
        attempts: 0,
        maxAttempts: 3,
        rawPayload: {},
      },
    });

    // 2. Intento 1: Worker procesa y envía al adaptador
    (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
      success: true,
      messageId: outbound1,
    });

    const res1 = await worker1.processRecord(msg.id);
    expect(res1).toBe(true);

    const postAttempt1Msg = await prisma.inboundMessage.findUnique({ where: { id: msg.id } });
    expect(postAttempt1Msg?.status).toBe('PROCESSED');
    expect(postAttempt1Msg?.attempts).toBe(1);
    expect(postAttempt1Msg?.outboundMessageId).toBe(outbound1);

    const attempt1 = await prisma.whatsAppSendAttempt.findFirst({
      where: { inboundMessageId: msg.id, attemptNumber: 1 },
    });
    expect(attempt1?.status).toBe('ACCEPTED');

    // 3. Webhook de Meta reporta fallo transitorio (131016: Service Unavailable)
    const reconciledFailed = await statusReconciler.ingestAndReconcile({
      id: outbound1,
      status: 'failed',
      timestamp: String(Math.floor(Date.now() / 1000)),
      recipient_id: '56977778888',
      biz_opaque_callback_data: attempt1?.id,
      errors: [{ code: 131016, title: 'Service temporarily unavailable' }],
    });
    expect(reconciledFailed).toBe(true);

    const postFailedMsg = await prisma.inboundMessage.findUnique({ where: { id: msg.id } });
    expect(postFailedMsg?.status).toBe('RETRY_PENDING');
    expect(postFailedMsg?.outboundMessageId).toBeNull(); // Limpiado para permitir nuevo envío
    expect(postFailedMsg?.nextRetryAt).not.toBeNull();

    const postFailedAttempt1 = await prisma.whatsAppSendAttempt.findUnique({
      where: { id: attempt1?.id },
    });
    expect(postFailedAttempt1?.status).toBe('RETRYABLE_REJECTION');
    expect(postFailedAttempt1?.outboundMessageId).toBe(outbound1); // Conservado en el historial

    // 4. Vencer artificialmente el backoff para simular el paso del tiempo
    await prisma.inboundMessage.update({
      where: { id: msg.id },
      data: { nextRetryAt: new Date(Date.now() - 5000) },
    });

    // 5. Intento 2: Worker procesa de nuevo tras vencer el backoff
    const outbound2 = `${TEST_PREFIX}_OUT_SECOND`;
    (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
      success: true,
      messageId: outbound2,
    });

    const res2 = await worker1.processRecord(msg.id);
    expect(res2).toBe(true);

    // 6. Verificación en PostgreSQL real del resultado final
    const finalMsg = await prisma.inboundMessage.findUnique({ where: { id: msg.id } });
    expect(finalMsg?.status).toBe('PROCESSED');
    expect(finalMsg?.attempts).toBe(2);
    expect(finalMsg?.outboundMessageId).toBe(outbound2);

    const allAttempts = await prisma.whatsAppSendAttempt.findMany({
      where: { inboundMessageId: msg.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(allAttempts.length).toBe(2);
    expect(allAttempts[0].status).toBe('RETRYABLE_REJECTION');
    expect(allAttempts[0].outboundMessageId).toBe(outbound1);
    expect(allAttempts[1].status).toBe('ACCEPTED');
    expect(allAttempts[1].outboundMessageId).toBe(outbound2);
  });

  it('recuperación tras interrupción de worker antes del envío: recupera mensaje sin agotar intentos de despacho', async () => {
    const extId = `${TEST_PREFIX}_CRASH_RECOVERY`;

    // Mensaje que quedó en CLAIMED hace 70 segundos por caída del proceso antes de enviar a Meta
    const staleDate = new Date(Date.now() - 70000);
    const msg = await prisma.inboundMessage.create({
      data: {
        externalMessageId: extId,
        fromPhone: '56988889999',
        messageType: 'text',
        content: 'Mensaje con worker caído',
        status: 'CLAIMED',
        claimToken: 'crashed-worker-token',
        claimRecoveryCount: 0,
        attempts: 0,
        maxAttempts: 3,
        processingStartedAt: staleDate,
        rawPayload: {},
      },
    });

    // Ejecutar recuperación de leases expirados
    const recovered = await worker1.recoverExpiredLeases();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const freshMsg = await prisma.inboundMessage.findUnique({ where: { id: msg.id } });
    // Vuelve a RECEIVED
    expect(freshMsg?.status).toBe('RECEIVED');
    // Incrementó recuperaciones pero NO intentos de despacho
    expect(freshMsg?.claimRecoveryCount).toBe(1);
    expect(freshMsg?.attempts).toBe(0);
    expect(freshMsg?.claimToken).toBeNull();
  });
});
