import { AppLogger } from '../../common/logging/logger.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor';
import { WhatsAppSenderAdapter } from './whatsapp-sender.adapter';
import { WhatsAppStatusReconcilerService } from './whatsapp-status-reconciler.service';

describe('WhatsAppQueueProcessor', () => {
  let processor: WhatsAppQueueProcessor;
  let mockPrisma: {
    inboundMessage: {
      updateMany: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    whatsAppSendAttempt: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let mockSenderAdapter: Partial<WhatsAppSenderAdapter>;
  let mockStatusReconciler: Partial<WhatsAppStatusReconcilerService>;
  let mockLogger: Partial<AppLogger>;

  beforeEach(() => {
    mockPrisma = {
      inboundMessage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      whatsAppSendAttempt: {
        create: jest.fn().mockResolvedValue({ id: 'attempt-uuid-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn(),
      },
      $transaction: jest.fn(async (args) => {
        if (Array.isArray(args)) {
          return Promise.all(args);
        }
        if (typeof args === 'function') {
          return args(mockPrisma);
        }
        return args;
      }),
    };

    mockSenderAdapter = {
      sendTextMessage: jest.fn(),
    };

    mockStatusReconciler = {
      ingestAndReconcile: jest.fn().mockResolvedValue(true),
      reconcilePendingEvents: jest.fn().mockResolvedValue(0),
    };

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    processor = new WhatsAppQueueProcessor(
      mockPrisma as unknown as PrismaService,
      mockSenderAdapter as WhatsAppSenderAdapter,
      mockStatusReconciler as WhatsAppStatusReconcilerService,
      mockLogger as AppLogger,
    );
  });

  afterEach(() => {
    processor.stopWorker();
  });

  describe('S2.06-A: Reclamo atómico y prevención de envíos concurrentes', () => {
    it('dos ejecuciones simultáneas del mismo registro producen una sola llamada al adaptador', async () => {
      const recordId = 'rec-concurrent-1';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 1,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        content: 'Consulta concurrente',
        status: 'CLAIMED',
        responseSent: false,
        outboundMessageId: null,
      });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: true,
        messageId: 'wamid.HBgL123456',
      });

      const [res1, res2] = await Promise.all([
        processor.processRecord(recordId),
        processor.processRecord(recordId),
      ]);

      expect(res1 || res2).toBe(true);
      expect(res1 && res2).toBe(false);
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('si el mensaje ya tiene responseSent = true o outboundMessageId, evita duplicación saliente', async () => {
      const recordId = 'rec-already-sent';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 1,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        content: 'Ya enviado',
        status: 'CLAIMED',
        responseSent: true,
        outboundMessageId: 'wamid.EXISTING_OUTBOUND_ID',
      });

      mockPrisma.inboundMessage.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await processor.processRecord(recordId);

      expect(result).toBe(true);
      expect(mockSenderAdapter.sendTextMessage).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('ya fue enviado previamente'),
        'WhatsAppQueueProcessor',
      );
    });

    it('transición atómica CLAIMED -> SENDING: si el lease expiró antes del despacho, aborta y no llama a Meta', async () => {
      const recordId = 'rec-lease-expired';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 1,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        content: 'Mensaje tardío',
        status: 'CLAIMED',
        responseSent: false,
        outboundMessageId: null,
      });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claimRecord
        .mockResolvedValueOnce({ count: 0 }); // CLAIMED -> SENDING falló

      const result = await processor.processRecord(recordId);

      expect(result).toBe(false);
      expect(mockSenderAdapter.sendTextMessage).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Reclamo perdido o expirado'),
        'WhatsAppQueueProcessor',
      );
    });
  });

  describe('S2.09-B: Falla de base de datos tras envío aceptado por Meta (no duplicar)', () => {
    it('si Meta acepta pero falla PostgreSQL, la expiración de lease marca UNCERTAIN sin reenviar a Meta', async () => {
      const recordId = 'rec-db-fail-after-meta';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 1,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        content: 'Consulta crítica',
        status: 'CLAIMED',
        responseSent: false,
        outboundMessageId: null,
      });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claimRecord
        .mockResolvedValueOnce({ count: 1 }); // CLAIMED -> SENDING

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: true,
        messageId: 'wamid.META_ACCEPTED_999',
      });

      mockPrisma.$transaction
        .mockImplementationOnce(async (fn) => (typeof fn === 'function' ? fn(mockPrisma) : fn))
        .mockRejectedValueOnce(new Error('PostgreSQL connection terminated unexpectedly'));

      const result = await processor.processRecord(recordId);

      expect(result).toBe(true);
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(1);

      mockPrisma.inboundMessage.findMany
        .mockResolvedValueOnce([]) // CLAIMED
        .mockResolvedValueOnce([
          {
            id: recordId,
            status: 'SENDING',
            processingStartedAt: new Date(Date.now() - 120000),
            claimToken: 'token-worker-1',
            attempts: 1,
          },
        ]);

      mockPrisma.inboundMessage.updateMany.mockResolvedValue({ count: 1 });
      const recoveredCount = await processor.recoverExpiredLeases();

      expect(recoveredCount).toBe(1);
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: recordId, status: 'SENDING' }),
          data: expect.objectContaining({
            status: 'UNCERTAIN',
            deliveryUncertain: true,
          }),
        }),
      );
    });
  });

  describe('Problema 1: Anti-sobrescritura entre Worker y Webhooks Concurrentes', () => {
    it('carrera delivered -> timeout: confirmación por webhook prevalece y timeout tardío no degrada a UNCERTAIN', async () => {
      const recordId = 'rec-delivered-then-timeout';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 0,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        status: 'CLAIMED',
      });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // CLAIMED -> SENDING

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: false,
        errorType: 'UNCERTAIN_TIMEOUT',
        error: 'Timeout esperando Meta API (2500ms)',
      });

      // El webhook concurrente ya marcó PROCESSED, por lo que updateMany con status: 'SENDING' retorna count: 0
      mockPrisma.inboundMessage.updateMany.mockResolvedValueOnce({ count: 0 });

      await processor.processRecord(recordId);

      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: recordId,
            status: { in: ['SENDING'] },
          }),
          data: expect.objectContaining({
            status: 'UNCERTAIN',
          }),
        }),
      );
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('no fue degradado a UNCERTAIN porque su estado ya fue confirmado'),
        'WhatsAppQueueProcessor',
      );
    });

    it('carrera failed -> HTTP 200: webhook failed prevalece y HTTP 200 tardío no sobreescribe FAILED_FINAL', async () => {
      const recordId = 'rec-failed-then-http200';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 0,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        status: 'CLAIMED',
      });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // CLAIMED -> SENDING

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: true,
        messageId: 'wamid.LATE_HTTP_200',
      });

      // El webhook concurrente ya marcó FAILED_FINAL, por lo que updateMany retorna count: 0
      mockPrisma.inboundMessage.updateMany.mockResolvedValueOnce({ count: 0 });

      await processor.processRecord(recordId);

      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: recordId,
            status: { in: ['SENDING', 'UNCERTAIN'] },
          }),
          data: expect.objectContaining({
            status: 'PROCESSED',
          }),
        }),
      );
    });
  });

  describe('Problema 1 & 3: Respeto integral de record.maxAttempts y Coherencia de deliveryUncertain', () => {
    it('con maxAttempts: 5, tras 3 fallos previos el mensaje en RETRY_PENDING es seleccionado por processPendingQueue y ejecuta exitosamente el intento 4', async () => {
      const recordId = 'rec-max-attempts-5';

      // findMany en recoverExpiredLeases
      mockPrisma.inboundMessage.findMany
        .mockResolvedValueOnce([]) // CLAIMED
        .mockResolvedValueOnce([]) // SENDING
        // findMany en processPendingQueue: selecciona el mensaje en RETRY_PENDING sin filtro estático < 3
        .mockResolvedValueOnce([
          {
            id: recordId,
            attempts: 3,
            maxAttempts: 5,
            status: 'RETRY_PENDING',
            nextRetryAt: new Date(Date.now() - 5000),
          },
        ])
        .mockResolvedValueOnce([]); // fin de cola

      mockPrisma.inboundMessage.findUnique
        .mockResolvedValueOnce({
          id: recordId,
          attempts: 3,
          maxAttempts: 5,
          status: 'RETRY_PENDING',
        })
        .mockResolvedValueOnce({
          id: recordId,
          fromPhone: '56912345678',
          messageType: 'text',
          status: 'CLAIMED',
          attempts: 3,
          maxAttempts: 5,
        });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claimRecord (attempts < 5)
        .mockResolvedValueOnce({ count: 1 }); // CLAIMED -> SENDING (attempts pasa a 4)

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: true,
        messageId: 'wamid.ATTEMPT_4_SUCCESS',
      });

      const totalProcessed = await processor.processPendingQueue();

      expect(totalProcessed).toBe(1);
      // Comprueba que claimRecord verificó attempts < 5
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: recordId,
            attempts: { lt: 5 },
          }),
          data: expect.objectContaining({
            status: 'CLAIMED',
          }),
        }),
      );
      // Comprueba que se creó WhatsAppSendAttempt con attemptNumber: 4
      expect(mockPrisma.whatsAppSendAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inboundMessageId: recordId,
            attemptNumber: 4,
            status: 'INITIATED',
          }),
        }),
      );
      // Comprueba que Meta adapter fue despachado en este cuarto intento
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('coherencia integral: mensaje recuperado como UNCERTAIN limpia deliveryUncertain: false al recibir respuesta exitosa', async () => {
      const recordId = 'rec-uncertain-then-success';

      mockPrisma.inboundMessage.findUnique
        .mockResolvedValueOnce({
          id: recordId,
          attempts: 1,
          maxAttempts: 3,
        })
        .mockResolvedValueOnce({
          id: recordId,
          fromPhone: '56912345678',
          messageType: 'text',
          status: 'CLAIMED',
          deliveryUncertain: true,
          attempts: 1,
          maxAttempts: 3,
        });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }) // SENDING
        .mockResolvedValueOnce({ count: 1 }); // PROCESSED

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: true,
        messageId: 'wamid.SUCCESS_AFTER_UNCERTAIN',
      });

      const result = await processor.processRecord(recordId);

      expect(result).toBe(true);
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: recordId }),
          data: expect.objectContaining({
            status: 'PROCESSED',
            deliveryUncertain: false,
            responseSent: true,
          }),
        }),
      );
    });

    it('claimRecord NO incrementa attempts; attempts se incrementa únicamente al pasar a SENDING', async () => {
      const recordId = 'rec-attempts-isolation';

      mockPrisma.inboundMessage.findUnique.mockResolvedValueOnce({
        id: recordId,
        attempts: 0,
        maxAttempts: 3,
      });

      mockPrisma.inboundMessage.updateMany.mockResolvedValueOnce({ count: 1 });

      await processor.claimRecord(recordId);

      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            attempts: expect.anything(),
          }),
        }),
      );
    });

    it('caídas en CLAIMED no consumen attempts de envío: una caída restaura a RECEIVED con attempts = 0', async () => {
      const recordId = 'rec-1-lease-crash';

      mockPrisma.inboundMessage.findMany
        .mockResolvedValueOnce([
          {
            id: recordId,
            externalMessageId: 'wamid.CRASH_1',
            status: 'CLAIMED',
            processingStartedAt: new Date(Date.now() - 120000),
            claimRecoveryCount: 0,
          },
        ])
        .mockResolvedValueOnce([]);

      mockPrisma.inboundMessage.updateMany.mockResolvedValueOnce({ count: 1 });

      const recovered = await processor.recoverExpiredLeases();

      expect(recovered).toBe(1);
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: recordId, status: 'CLAIMED' }),
          data: expect.objectContaining({
            status: 'RECEIVED',
            claimRecoveryCount: 1,
          }),
        }),
      );
    });

    it('tras 3 caídas en CLAIMED antes de SENDING, transiciona explícitamente a FAILED_FINAL para revisión', async () => {
      const recordId = 'rec-3-lease-crashes';

      mockPrisma.inboundMessage.findMany
        .mockResolvedValueOnce([
          {
            id: recordId,
            externalMessageId: 'wamid.CRASH_LOOP',
            status: 'CLAIMED',
            processingStartedAt: new Date(Date.now() - 120000),
            claimRecoveryCount: 2,
          },
        ])
        .mockResolvedValueOnce([]);

      mockPrisma.inboundMessage.updateMany.mockResolvedValueOnce({ count: 1 });

      const recovered = await processor.recoverExpiredLeases();

      expect(recovered).toBe(1);
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: recordId, status: 'CLAIMED' }),
          data: expect.objectContaining({
            status: 'FAILED_FINAL',
            claimRecoveryCount: 3,
            deliveryUncertain: false,
            errorMessage: expect.stringContaining('Límite de recuperaciones de reclamo'),
          }),
        }),
      );
    });

    it('respeta maxAttempts configurado en el registro (única fuente de verdad)', async () => {
      const recordId = 'rec-max-custom';

      mockPrisma.inboundMessage.findUnique.mockResolvedValueOnce({
        id: recordId,
        attempts: 1,
        maxAttempts: 1, // Límite de 1 intento ya alcanzado
      });

      const result = await processor.claimRecord(recordId);

      expect(result.claimed).toBe(false);
      expect(mockSenderAdapter.sendTextMessage).not.toHaveBeenCalled();
    });

    it('un valor inválido de maxAttempts (0, negativo o fuera de rango) no se convierte silenciosamente y marca FAILED_FINAL', async () => {
      const recordId = 'rec-max-invalid';

      mockPrisma.inboundMessage.findUnique.mockResolvedValueOnce({
        id: recordId,
        attempts: 0,
        maxAttempts: 0, // Inválido: menor al mínimo permitido (1)
      });

      const result = await processor.claimRecord(recordId);

      expect(result.claimed).toBe(false);
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: recordId }),
          data: expect.objectContaining({
            status: 'FAILED_FINAL',
            errorMessage: expect.stringContaining('Rango estrictamente admitido'),
          }),
        }),
      );
      expect(mockSenderAdapter.sendTextMessage).not.toHaveBeenCalled();
    });
  });

  describe('Problema 4: Códigos de Meta 131030 y 131031 como errores fatales sin reintento', () => {
    it('error 131030 (destinatario no en sandbox whitelist) transiciona inmediatamente a FAILED_FINAL', async () => {
      const recordId = 'rec-meta-131030';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 0,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        status: 'CLAIMED',
      });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // CLAIMED -> SENDING

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: false,
        errorType: 'EXPLICIT_FATAL',
        error:
          'Meta API Error (131030): El destinatario no está incluido en la lista de números permitidos para el entorno de prueba de Meta.',
      });

      await processor.processRecord(recordId);

      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: recordId }),
          data: expect.objectContaining({
            status: 'FAILED_FINAL',
            deliveryUncertain: false,
            nextRetryAt: null,
            errorMessage: expect.stringContaining('131030'),
          }),
        }),
      );
      expect(mockPrisma.whatsAppSendAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FATAL_FAILURE',
          }),
        }),
      );
    });

    it('error 131031 (cuenta bloqueada por Meta) transiciona inmediatamente a FAILED_FINAL', async () => {
      const recordId = 'rec-meta-131031';

      mockPrisma.inboundMessage.findUnique.mockResolvedValue({
        id: recordId,
        attempts: 0,
        maxAttempts: 3,
        fromPhone: '56912345678',
        messageType: 'text',
        status: 'CLAIMED',
      });

      mockPrisma.inboundMessage.updateMany
        .mockResolvedValueOnce({ count: 1 }) // claim
        .mockResolvedValueOnce({ count: 1 }); // CLAIMED -> SENDING

      (mockSenderAdapter.sendTextMessage as jest.Mock).mockResolvedValueOnce({
        success: false,
        errorType: 'EXPLICIT_FATAL',
        error:
          'Meta API Error (131031): La cuenta de WhatsApp Business se encuentra bloqueada o con restricciones de pago/políticas.',
      });

      await processor.processRecord(recordId);

      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: recordId }),
          data: expect.objectContaining({
            status: 'FAILED_FINAL',
            deliveryUncertain: false,
            nextRetryAt: null,
            errorMessage: expect.stringContaining('131031'),
          }),
        }),
      );
      expect(mockPrisma.whatsAppSendAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FATAL_FAILURE',
          }),
        }),
      );
    });
  });

  describe('S2.09-A: Recuperación continua por lotes y barrido de reconciliación', () => {
    it('procesa lotes continuos de 75 registros y ejecuta barrido de reconciliación', async () => {
      const makeBatch = (start: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: `batch-item-${start + i}`,
          status: 'RECEIVED',
        }));

      const batch1 = makeBatch(1, 25);
      const batch2 = makeBatch(26, 25);
      const batch3 = makeBatch(51, 25);

      mockPrisma.inboundMessage.findMany
        .mockResolvedValueOnce([]) // recoverExpiredLeases (CLAIMED)
        .mockResolvedValueOnce([]) // recoverExpiredLeases (SENDING)
        .mockResolvedValueOnce(batch1) // lote 1
        .mockResolvedValueOnce(batch2) // lote 2
        .mockResolvedValueOnce(batch3) // lote 3
        .mockResolvedValueOnce([]); // fin de la cola

      jest.spyOn(processor, 'processRecord').mockResolvedValue(true);

      const totalRecovered = await processor.processPendingQueue();

      expect(totalRecovered).toBe(75);
      expect(processor.processRecord).toHaveBeenCalledTimes(75);
      expect(mockStatusReconciler.reconcilePendingEvents).toHaveBeenCalledTimes(1);
    });

    it('trigger() ejecuta processPendingQueue en el siguiente tick sin bloquear', (done) => {
      jest.spyOn(processor, 'processPendingQueue').mockResolvedValue(1);

      processor.trigger();

      setImmediate(() => {
        expect(processor.processPendingQueue).toHaveBeenCalled();
        done();
      });
    });
  });

  describe('Cálculo de backoff exponencial', () => {
    it('aplica tiempos de espera progresivos 5s, 15s y 45s según el número de intento', () => {
      const now = Date.now();
      const date1 = processor.calculateNextRetry(1);
      const date2 = processor.calculateNextRetry(2);
      const date3 = processor.calculateNextRetry(3);

      expect(date1.getTime() - now).toBeGreaterThanOrEqual(4900);
      expect(date1.getTime() - now).toBeLessThanOrEqual(6000);

      expect(date2.getTime() - now).toBeGreaterThanOrEqual(14900);
      expect(date2.getTime() - now).toBeLessThanOrEqual(16000);

      expect(date3.getTime() - now).toBeGreaterThanOrEqual(44900);
      expect(date3.getTime() - now).toBeLessThanOrEqual(46000);
    });
  });

  describe('S2.09-B: Reintento efectivo tras webhook de fallo transitorio y resolución de agotados', () => {
    it('aceptación HTTP → webhook de fallo transitorio → vencimiento del backoff → segundo envío real al adaptador', async () => {
      const recordId = 'rec-retry-flow-1';

      let attemptCount = 0;
      mockPrisma.inboundMessage.findUnique.mockImplementation(async () => ({
        id: recordId,
        externalMessageId: 'wamid.INBOUND_FLOW_1',
        fromPhone: '56912345678',
        messageType: 'text',
        content: 'Hola autos',
        attempts: attemptCount,
        maxAttempts: 3,
        status: attemptCount === 0 ? 'RECEIVED' : 'RETRY_PENDING',
        responseSent: false,
        outboundMessageId: null,
      }));

      mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce(null); // sin intentos previos
      mockPrisma.inboundMessage.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.whatsAppSendAttempt.create
        .mockResolvedValueOnce({ id: 'attempt-uuid-1', attemptNumber: 1 })
        .mockResolvedValueOnce({ id: 'attempt-uuid-2', attemptNumber: 2 });

      (mockSenderAdapter.sendTextMessage as jest.Mock)
        .mockResolvedValueOnce({
          success: true,
          messageId: 'wamid.OUTBOUND_1',
        })
        .mockResolvedValueOnce({
          success: true,
          messageId: 'wamid.OUTBOUND_2',
        });

      // Ejecutar intento 1
      const res1 = await processor.processRecord(recordId);
      expect(res1).toBe(true);
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenLastCalledWith(
        '56912345678',
        expect.any(String),
        'attempt-uuid-1',
      );

      // 2. Simulación de webhook fallido transitorio:
      // el reconciliador pasa el mensaje a RETRY_PENDING, anula outboundMessageId y el intento 1 queda como RETRYABLE_REJECTION
      attemptCount = 1;
      const attempt1Record = {
        id: 'attempt-uuid-1',
        inboundMessageId: recordId,
        attemptNumber: 1,
        status: 'RETRYABLE_REJECTION',
        outboundMessageId: 'wamid.OUTBOUND_1',
      };

      // 3. Vencimiento del backoff y ejecución del segundo intento (intento 2)
      mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce(attempt1Record);

      const res2 = await processor.processRecord(recordId);

      expect(res2).toBe(true);
      // Comprobar que efectivamente se realizó el segundo envío al adaptador
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenCalledTimes(2);
      expect(mockSenderAdapter.sendTextMessage).toHaveBeenLastCalledWith(
        '56912345678',
        expect.any(String),
        'attempt-uuid-2',
      );
    });

    it('25 registros agotados seguidos de uno válido: el válido se procesa y el ciclo termina', async () => {
      const exhaustedBatch = Array.from({ length: 25 }, (_, i) => ({
        id: `rec-exhausted-${i + 1}`,
        attempts: 3,
        maxAttempts: 3,
        status: 'RECEIVED',
      }));

      const validRecord = {
        id: 'rec-valid-26',
        attempts: 0,
        maxAttempts: 3,
        status: 'RECEIVED',
      };

      mockPrisma.inboundMessage.findMany
        .mockResolvedValueOnce([]) // recoverExpiredLeases (CLAIMED)
        .mockResolvedValueOnce([]) // recoverExpiredLeases (SENDING)
        .mockResolvedValueOnce(exhaustedBatch) // lote 1: 25 registros agotados
        .mockResolvedValueOnce([validRecord]) // lote 2: 1 registro válido
        .mockResolvedValueOnce([]); // lote 3: vacío

      jest.spyOn(processor, 'processRecord').mockResolvedValue(true);

      const totalProcessed = await processor.processPendingQueue();

      expect(totalProcessed).toBe(1);
      // Los 25 registros agotados fueron resueltos a FAILED_FINAL
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'rec-exhausted-1',
            attempts: { gte: 3 },
          }),
          data: expect.objectContaining({
            status: 'FAILED_FINAL',
            deliveryUncertain: false,
          }),
        }),
      );
      // El registro válido fue procesado
      expect(processor.processRecord).toHaveBeenCalledWith('rec-valid-26');
    });

    it('salida defensiva: si un lote de 25 registros no produce progreso ni resolución, rompe el bucle para evitar bucle infinito', async () => {
      const unclaimableBatch = Array.from({ length: 25 }, (_, i) => ({
        id: `rec-unclaimable-${i + 1}`,
        attempts: 1,
        maxAttempts: 3,
        status: 'RECEIVED',
      }));

      mockPrisma.inboundMessage.findMany
        .mockResolvedValueOnce([]) // recoverExpiredLeases
        .mockResolvedValueOnce([]) // recoverExpiredLeases
        .mockResolvedValue(unclaimableBatch); // siempre devuelve el mismo lote

      jest.spyOn(processor, 'processRecord').mockResolvedValue(false); // nada procesado

      const totalProcessed = await processor.processPendingQueue();

      expect(totalProcessed).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Lote de pendientes no produjo progreso; interrumpiendo ciclo'),
        'WhatsAppQueueProcessor',
      );
    });
  });
});
