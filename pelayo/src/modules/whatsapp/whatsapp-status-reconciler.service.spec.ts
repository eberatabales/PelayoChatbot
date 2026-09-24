import { Prisma } from '@prisma/client';
import { AppLogger } from '../../common/logging/logger.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WhatsAppStatusReconcilerService } from './whatsapp-status-reconciler.service';
import { WhatsAppRawStatus } from './whatsapp.types';

describe('WhatsAppStatusReconcilerService', () => {
  let service: WhatsAppStatusReconcilerService;
  let mockPrisma: {
    whatsAppStatusEvent: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
    };
    whatsAppSendAttempt: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    inboundMessage: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let mockLogger: Partial<AppLogger>;

  beforeEach(() => {
    mockPrisma = {
      whatsAppStatusEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1', reconciled: false }),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      whatsAppSendAttempt: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inboundMessage: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    service = new WhatsAppStatusReconcilerService(
      mockPrisma as unknown as PrismaService,
      mockLogger as AppLogger,
    );
  });

  it('persiste un evento de estado y si ya fue reconciliado retorna true sin re-procesar', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.HBgL123',
      status: 'delivered',
      timestamp: '1726950100',
      recipient_id: '56912345678',
    };

    mockPrisma.whatsAppStatusEvent.findUnique.mockResolvedValueOnce({
      id: 'evt-already-done',
      statusId: 'wamid.HBgL123_delivered_1726950100',
      reconciled: true,
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('ya reconciliado previamente'),
      'WhatsAppStatusReconcilerService',
    );
    expect(mockPrisma.whatsAppSendAttempt.findFirst).not.toHaveBeenCalled();
  });

  it('si ocurre P2002 por concurrencia pero el evento aún no está reconciliado, procede con la reconciliación', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.HBgLP2002',
      status: 'delivered',
      timestamp: '1726950101',
      recipient_id: '56912345678',
    };

    mockPrisma.whatsAppStatusEvent.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'evt-existing',
      reconciled: false,
    });

    const duplicateError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.0.0',
    });
    mockPrisma.whatsAppStatusEvent.create.mockRejectedValueOnce(duplicateError);

    mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-p2002',
      inboundMessageId: 'msg-p2002',
      outboundMessageId: 'wamid.HBgLP2002',
      status: 'INITIATED',
      inboundMessage: {
        id: 'msg-p2002',
        status: 'UNCERTAIN',
        responseSent: false,
      },
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it('reconcilia estrictamente por biz_opaque_callback_data (attemptId) sin tocar otros mensajes del mismo teléfono', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.OUTBOUND_A',
      status: 'delivered',
      timestamp: '1726950200',
      recipient_id: '56999998888',
      biz_opaque_callback_data: 'attempt-uuid-A',
    };

    mockPrisma.whatsAppSendAttempt.findUnique.mockResolvedValueOnce({
      id: 'attempt-uuid-A',
      inboundMessageId: 'msg-A',
      outboundMessageId: 'wamid.OUTBOUND_A',
      status: 'INITIATED',
      inboundMessage: {
        id: 'msg-A',
        externalMessageId: 'wamid.INBOUND_A',
        status: 'UNCERTAIN',
        responseSent: false,
      },
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockPrisma.whatsAppSendAttempt.findUnique).toHaveBeenCalledWith({
      where: { id: 'attempt-uuid-A' },
      include: { inboundMessage: true },
    });
    expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'msg-A' }),
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    );
  });

  it('reconcilia exitosamente un mensaje en estado UNCERTAIN cuando recibe status sent/delivered por outboundMessageId', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.HBgLConfirmed',
      status: 'delivered',
      timestamp: '1726950201',
      recipient_id: '56912345678',
    };

    mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-1',
      inboundMessageId: 'msg-1',
      outboundMessageId: 'wamid.HBgLConfirmed',
      status: 'INITIATED',
      inboundMessage: {
        id: 'msg-1',
        externalMessageId: 'wamid.INBOUND_001',
        status: 'UNCERTAIN',
        responseSent: false,
      },
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'msg-1' }),
        data: expect.objectContaining({
          status: 'PROCESSED',
          responseSent: true,
          deliveryUncertain: false,
          outboundMessageId: 'wamid.HBgLConfirmed',
        }),
      }),
    );
    expect(mockPrisma.whatsAppSendAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'attempt-1' }),
        data: expect.objectContaining({
          status: 'DELIVERED',
          outboundMessageId: 'wamid.HBgLConfirmed',
        }),
      }),
    );
  });

  it('no adivina por teléfono si no encuentra intento ni por opaque callback data ni por outboundMessageId', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.UNKNOWN_OUTBOUND',
      status: 'delivered',
      timestamp: '1726950250',
      recipient_id: '56912345678',
    };

    mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce(null);
    mockPrisma.inboundMessage.findFirst.mockResolvedValueOnce(null);

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(false);
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('sin coincidencia unívoca'),
      'WhatsAppStatusReconcilerService',
    );
    expect(mockPrisma.inboundMessage.updateMany).not.toHaveBeenCalled();
  });

  it('marca intento como FATAL_FAILURE y clasifica con classifyMetaError si Meta reporta status failed', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.HBgLFailedMsg',
      status: 'failed',
      timestamp: '1726950300',
      recipient_id: '56912345678',
      errors: [
        {
          code: 131026,
          title: 'Message Undeliverable',
        },
      ],
    };

    mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-2',
      inboundMessageId: 'msg-2',
      outboundMessageId: 'wamid.HBgLFailedMsg',
      inboundMessage: {
        id: 'msg-2',
        externalMessageId: 'wamid.INBOUND_002',
        status: 'SENDING',
      },
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockPrisma.whatsAppSendAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'attempt-2' }),
        data: expect.objectContaining({
          status: 'FATAL_FAILURE',
          errorMessage: expect.stringContaining('131026'),
        }),
      }),
    );
    expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'msg-2' }),
        data: expect.objectContaining({
          status: 'FAILED_FINAL',
        }),
      }),
    );
  });

  it('rechaza degradación contradictoria si el intento ya estaba en estado de entrega confirmada (DELIVERED o READ)', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.HBgLAlreadyDelivered',
      status: 'failed',
      timestamp: '1726950350',
      recipient_id: '56912345678',
      errors: [
        {
          code: 131026,
          title: 'Message Undeliverable',
        },
      ],
    };

    mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-already-delivered',
      inboundMessageId: 'msg-delivered',
      outboundMessageId: 'wamid.HBgLAlreadyDelivered',
      status: 'DELIVERED', // Entrega ya confirmada físicamente
      inboundMessage: {
        id: 'msg-delivered',
        externalMessageId: 'wamid.INBOUND_DELIVERED',
        status: 'PROCESSED',
        deliveryUncertain: false,
      },
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rechazando degradación contradictoria'),
      'WhatsAppStatusReconcilerService',
    );
    // No debe actualizar el intento a FATAL_FAILURE ni el mensaje a FAILED_FINAL
    expect(mockPrisma.inboundMessage.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.whatsAppStatusEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reconciled: true,
          abandoned: false,
          lastError: expect.stringContaining('Evento contradictorio descartado'),
        }),
      }),
    );
  });

  it('webhook failed con error transitorio (código 131016) transiciona mensaje a RETRY_PENDING si attempts < maxAttempts', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.HBgLRetryableFailed',
      status: 'failed',
      timestamp: '1726950400',
      recipient_id: '56912345678',
      errors: [
        {
          code: 131016,
          title: 'Service temporarily unavailable',
        },
      ],
    };

    mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-retryable',
      inboundMessageId: 'msg-retryable',
      outboundMessageId: 'wamid.HBgLRetryableFailed',
      status: 'ACCEPTED',
      inboundMessage: {
        id: 'msg-retryable',
        externalMessageId: 'wamid.INBOUND_RETRYABLE',
        status: 'PROCESSED',
        attempts: 1,
        maxAttempts: 3,
        deliveryUncertain: true,
      },
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'msg-retryable' }),
        data: expect.objectContaining({
          status: 'RETRY_PENDING',
          responseSent: false,
          deliveryUncertain: false,
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
    expect(mockPrisma.whatsAppSendAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'attempt-retryable' }),
        data: expect.objectContaining({
          status: 'RETRYABLE_REJECTION',
          errorMessage: expect.stringContaining('131016'),
        }),
      }),
    );
  });

  it('webhook delivered sobre mensaje ya en PROCESSED con deliveryUncertain: true limpia deliveryUncertain a false', async () => {
    const rawStatus: WhatsAppRawStatus = {
      id: 'wamid.HBgLCleanUncertain',
      status: 'delivered',
      timestamp: '1726950500',
      recipient_id: '56912345678',
    };

    mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce({
      id: 'attempt-uncertain',
      inboundMessageId: 'msg-uncertain',
      outboundMessageId: 'wamid.HBgLCleanUncertain',
      status: 'ACCEPTED',
      inboundMessage: {
        id: 'msg-uncertain',
        externalMessageId: 'wamid.INBOUND_UNCERTAIN',
        status: 'PROCESSED',
        deliveryUncertain: true,
      },
    });

    const result = await service.ingestAndReconcile(rawStatus);

    expect(result).toBe(true);
    expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'msg-uncertain' }),
        data: expect.objectContaining({
          status: 'PROCESSED',
          deliveryUncertain: false,
        }),
      }),
    );
  });

  describe('Problema 2: Head-of-Line Blocking y Aislamiento de Errores', () => {
    it('50 eventos sin correspondencia no bloquean al evento 51 válido, el cual se reconcilia exitosamente', async () => {
      // 50 eventos no correspondientes (sin intento asociado)
      const unmatchableEvents = Array.from({ length: 50 }, (_, i) => ({
        id: `unmatchable-${i + 1}`,
        statusId: `unmatchable-status-${i + 1}`,
        externalMessageId: `wamid.UNKNOWN_${i + 1}`,
        recipientId: '56911112222',
        status: 'delivered',
        timestamp: '1726950000',
        reconcileAttempts: 0,
        reconciled: false,
        abandoned: false,
        rawPayload: {},
      }));

      // Evento 51 válido
      const validEvent = {
        id: 'valid-event-51',
        statusId: 'valid-status-51',
        externalMessageId: 'wamid.VALID_51',
        recipientId: '56933334444',
        status: 'delivered',
        timestamp: '1726950051',
        reconcileAttempts: 0,
        reconciled: false,
        abandoned: false,
        rawPayload: {},
      };

      // Mock de findMany:
      // Lote 1: devuelve los 50 eventos no correspondientes
      // Lote 2: devuelve el evento 51 válido (cuyo turno llegó porque los primeros 50 fueron pospuestos a futuro)
      mockPrisma.whatsAppStatusEvent.findMany
        .mockResolvedValueOnce(unmatchableEvents)
        .mockResolvedValueOnce([validEvent])
        .mockResolvedValueOnce([]);

      // Mock para los 50 eventos unmatchable: no encuentran intento
      mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValue(null);
      mockPrisma.inboundMessage.findFirst.mockResolvedValue(null);

      // Cuando llega al evento 51 válido, sí encuentra su intento:
      mockPrisma.whatsAppSendAttempt.findFirst.mockImplementation(async (args) => {
        if (args?.where?.outboundMessageId === 'wamid.VALID_51') {
          return {
            id: 'attempt-51',
            inboundMessageId: 'msg-51',
            outboundMessageId: 'wamid.VALID_51',
            status: 'INITIATED',
            inboundMessage: {
              id: 'msg-51',
              externalMessageId: 'wamid.INBOUND_51',
              status: 'SENDING',
            },
          };
        }
        return null;
      });

      const totalReconciled = await service.reconcilePendingEvents();

      expect(totalReconciled).toBe(1);
      // Los 50 eventos sin correspondencia deben haber sido reprogramados con nextReconcileAt a futuro
      expect(mockPrisma.whatsAppStatusEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'unmatchable-1' }),
          data: expect.objectContaining({
            reconcileAttempts: 1,
            nextReconcileAt: expect.any(Date),
            abandoned: false,
          }),
        }),
      );
      // El evento 51 fue reconciliado
      expect(mockPrisma.inboundMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'msg-51' }),
          data: expect.objectContaining({
            status: 'PROCESSED',
          }),
        }),
      );
    });

    it('un evento que lance una excepción en el bucle no interrumpe el procesamiento del resto del lote', async () => {
      const evtError = {
        id: 'evt-throwing-error',
        statusId: 'status-error',
        externalMessageId: 'wamid.ERR_MSG',
        recipientId: '56911112222',
        status: 'delivered',
        timestamp: '1726950000',
        reconcileAttempts: 0,
        reconciled: false,
        abandoned: false,
        rawPayload: {},
      };

      const evtSuccess = {
        id: 'evt-success-after-error',
        statusId: 'status-ok',
        externalMessageId: 'wamid.OK_MSG',
        recipientId: '56933334444',
        status: 'delivered',
        timestamp: '1726950001',
        reconcileAttempts: 0,
        reconciled: false,
        abandoned: false,
        rawPayload: {},
      };

      mockPrisma.whatsAppStatusEvent.findMany.mockResolvedValueOnce([evtError, evtSuccess]);

      // Simular que el primer evento lanza un error grave en DB
      jest
        .spyOn(service, 'ingestAndReconcile')
        .mockRejectedValueOnce(new Error('DB Connection Timeout transitorio'))
        .mockResolvedValueOnce(true); // el segundo tiene éxito

      const totalReconciled = await service.reconcilePendingEvents();

      expect(totalReconciled).toBe(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error al procesar evento de reconciliación [status-error]'),
        expect.any(String),
        'WhatsAppStatusReconcilerService',
      );
      // El evento que falló fue aislado y reprogramado
      expect(mockPrisma.whatsAppStatusEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'evt-throwing-error' }),
          data: expect.objectContaining({
            lastError: expect.stringContaining('DB Connection Timeout transitorio'),
          }),
        }),
      );
    });

    it('eventos no resueltos tras 5 intentos se marcan como abandoned: true para revisión manual', async () => {
      const evtExhausted = {
        id: 'evt-exhausted',
        statusId: 'status-exhausted',
        externalMessageId: 'wamid.EXHAUSTED',
        recipientId: '56911112222',
        status: 'delivered',
        timestamp: '1726950000',
        reconcileAttempts: 4, // Intento 5 por ocurrir
        reconciled: false,
        abandoned: false,
        rawPayload: {},
      };

      mockPrisma.whatsAppStatusEvent.findMany.mockResolvedValueOnce([evtExhausted]);
      mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValue(null);
      mockPrisma.inboundMessage.findFirst.mockResolvedValue(null);

      const totalReconciled = await service.reconcilePendingEvents();

      expect(totalReconciled).toBe(0);
      expect(mockPrisma.whatsAppStatusEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'evt-exhausted' }),
          data: expect.objectContaining({
            reconcileAttempts: 5,
            abandoned: true,
            lastError: expect.stringContaining('Abandonado tras 5 intentos'),
          }),
        }),
      );
    });
  });

  describe('S2.09-B: Inmutabilidad progresiva y aislamiento transaccional estricto', () => {
    it('procesar read -> delivered -> sent -> failed y comprobar que el intento conserva READ', async () => {
      let currentAttemptStatus = 'INITIATED';

      mockPrisma.whatsAppSendAttempt.findFirst.mockImplementation(async () => ({
        id: 'attempt-immutability-1',
        inboundMessageId: 'msg-immutability-1',
        outboundMessageId: 'wamid.HBgLImmutable',
        status: currentAttemptStatus,
        inboundMessage: {
          id: 'msg-immutability-1',
          externalMessageId: 'wamid.INBOUND_IMMUTABLE',
          status: 'PROCESSED',
          attempts: 1,
          maxAttempts: 3,
        },
      }));

      mockPrisma.whatsAppSendAttempt.findUnique.mockImplementation(async () => ({
        id: 'attempt-immutability-1',
        inboundMessageId: 'msg-immutability-1',
        outboundMessageId: 'wamid.HBgLImmutable',
        status: currentAttemptStatus,
        inboundMessage: {
          id: 'msg-immutability-1',
          externalMessageId: 'wamid.INBOUND_IMMUTABLE',
          status: 'PROCESSED',
          attempts: 1,
          maxAttempts: 3,
        },
      }));

      mockPrisma.whatsAppSendAttempt.updateMany.mockImplementation(async (args) => {
        if (!args.where?.status?.in || args.where.status.in.includes(currentAttemptStatus)) {
          currentAttemptStatus = args.data.status;
          return { count: 1 };
        }
        return { count: 0 };
      });

      // 1. Recibir read -> debe pasar a READ
      await service.ingestAndReconcile({
        id: 'wamid.HBgLImmutable',
        status: 'read',
        timestamp: '1726950600',
        recipient_id: '56912345678',
      });
      expect(currentAttemptStatus).toBe('READ');

      // 2. Recibir delivered retrasado -> no debe degradar a DELIVERED
      await service.ingestAndReconcile({
        id: 'wamid.HBgLImmutable',
        status: 'delivered',
        timestamp: '1726950605',
        recipient_id: '56912345678',
      });
      expect(currentAttemptStatus).toBe('READ');

      // 3. Recibir sent retrasado -> no debe degradar a SENT
      await service.ingestAndReconcile({
        id: 'wamid.HBgLImmutable',
        status: 'sent',
        timestamp: '1726950610',
        recipient_id: '56912345678',
      });
      expect(currentAttemptStatus).toBe('READ');

      // 4. Recibir failed retrasado -> no debe degradar a FATAL_FAILURE ni FAILED_FINAL
      await service.ingestAndReconcile({
        id: 'wamid.HBgLImmutable',
        status: 'failed',
        timestamp: '1726950615',
        recipient_id: '56912345678',
        errors: [{ code: 131026, title: 'Undeliverable' }],
      });
      expect(currentAttemptStatus).toBe('READ');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Rechazando degradación contradictoria'),
        'WhatsAppStatusReconcilerService',
      );
    });

    it('carrera de concurrencia: si el intento se confirma como DELIVERED antes del commit de failed, la transacción no modifica el mensaje', async () => {
      // matchingAttempt inicial parecía estar en ACCEPTED fuera de la transacción
      mockPrisma.whatsAppSendAttempt.findFirst.mockResolvedValueOnce({
        id: 'attempt-race-1',
        inboundMessageId: 'msg-race-1',
        outboundMessageId: 'wamid.HBgLRace',
        status: 'ACCEPTED',
        inboundMessage: {
          id: 'msg-race-1',
          externalMessageId: 'wamid.INBOUND_RACE',
          status: 'SENDING',
          attempts: 1,
          maxAttempts: 3,
        },
      });

      // Pero dentro de la transacción, findUnique obtiene el intento ya confirmado concurrentemente como DELIVERED
      mockPrisma.whatsAppSendAttempt.findUnique.mockResolvedValueOnce({
        id: 'attempt-race-1',
        inboundMessageId: 'msg-race-1',
        outboundMessageId: 'wamid.HBgLRace',
        status: 'DELIVERED',
        inboundMessage: {
          id: 'msg-race-1',
          externalMessageId: 'wamid.INBOUND_RACE',
          status: 'PROCESSED',
          attempts: 1,
          maxAttempts: 3,
        },
      });

      mockPrisma.inboundMessage.updateMany.mockClear();

      await service.ingestAndReconcile({
        id: 'wamid.HBgLRace',
        status: 'failed',
        timestamp: '1726950700',
        recipient_id: '56912345678',
        errors: [{ code: 131026, title: 'Undeliverable' }],
      });

      // No debe haber modificado inboundMessage a FAILED_FINAL ni RETRY_PENDING
      expect(mockPrisma.inboundMessage.updateMany).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Rechazando degradación contradictoria'),
        'WhatsAppStatusReconcilerService',
      );
    });

    it('fallo de intento histórico: si llega fallo para intento #1 pero ya existe intento #2 más reciente, no altera el mensaje', async () => {
      mockPrisma.whatsAppSendAttempt.findFirst
        .mockResolvedValueOnce({
          id: 'attempt-old-1',
          inboundMessageId: 'msg-multiatempt-1',
          outboundMessageId: 'wamid.OLD_1',
          attemptNumber: 1,
          status: 'INITIATED',
          inboundMessage: {
            id: 'msg-multiatempt-1',
            externalMessageId: 'wamid.INBOUND_MULTI',
            status: 'SENDING',
            attempts: 2,
            maxAttempts: 3,
          },
        })
        // Dentro de la transacción, findFirst buscando el latestAttempt devuelve intento #2:
        .mockResolvedValueOnce({
          id: 'attempt-new-2',
          inboundMessageId: 'msg-multiatempt-1',
          attemptNumber: 2,
          status: 'INITIATED',
        });

      mockPrisma.whatsAppSendAttempt.findUnique.mockResolvedValueOnce({
        id: 'attempt-old-1',
        inboundMessageId: 'msg-multiatempt-1',
        attemptNumber: 1,
        status: 'INITIATED',
        inboundMessage: {
          id: 'msg-multiatempt-1',
          externalMessageId: 'wamid.INBOUND_MULTI',
          status: 'SENDING',
          attempts: 2,
          maxAttempts: 3,
        },
      });

      mockPrisma.inboundMessage.updateMany.mockClear();

      await service.ingestAndReconcile({
        id: 'wamid.OLD_1',
        status: 'failed',
        timestamp: '1726950800',
        recipient_id: '56912345678',
        errors: [{ code: 131026, title: 'Undeliverable' }],
      });

      // No debe haber modificado inboundMessage
      expect(mockPrisma.inboundMessage.updateMany).not.toHaveBeenCalled();
      // Solo actualizó el intento histórico
      expect(mockPrisma.whatsAppSendAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'attempt-old-1' }),
          data: expect.objectContaining({ status: 'FATAL_FAILURE' }),
        }),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Fallo de intento histórico (#1) recibido'),
        'WhatsAppStatusReconcilerService',
      );
    });

    it('sent atrasado de A mientras B está en SENDING: no marca B como procesado ni reemplaza su ID', async () => {
      // 1. InboundMessage está en SENDING con attempts = 2 y outboundMessageId de B
      const msg = {
        id: 'msg-multi-pos-1',
        externalMessageId: 'wamid.INBOUND_MULTI_POS',
        status: 'SENDING',
        attempts: 2,
        maxAttempts: 3,
        outboundMessageId: 'wamid.B_SENDING_ID',
      };

      // 2. Coincidencia inicial por wamid.A_OLD encuentra el intento A (#1)
      mockPrisma.whatsAppSendAttempt.findFirst
        .mockResolvedValueOnce({
          id: 'attempt-A-1',
          inboundMessageId: msg.id,
          attemptNumber: 1,
          status: 'UNCERTAIN',
          outboundMessageId: 'wamid.A_OLD',
          inboundMessage: msg,
        })
        // Dentro de la transacción, findFirst buscando el latestAttempt devuelve intento B (#2)
        .mockResolvedValueOnce({
          id: 'attempt-B-2',
          inboundMessageId: msg.id,
          attemptNumber: 2,
          status: 'INITIATED',
          outboundMessageId: 'wamid.B_SENDING_ID',
        });

      mockPrisma.whatsAppSendAttempt.findUnique.mockResolvedValueOnce({
        id: 'attempt-A-1',
        inboundMessageId: msg.id,
        attemptNumber: 1,
        status: 'UNCERTAIN',
        outboundMessageId: 'wamid.A_OLD',
        inboundMessage: msg,
      });

      mockPrisma.inboundMessage.updateMany.mockClear();

      const result = await service.ingestAndReconcile({
        id: 'wamid.A_OLD',
        status: 'sent',
        timestamp: '1726950900',
        recipient_id: '56912345678',
      });

      expect(result).toBe(true);

      // Verificación crítica: NUNCA debe haber modificado inboundMessage
      expect(mockPrisma.inboundMessage.updateMany).not.toHaveBeenCalled();

      // El evento fue marcado como reconciliado y se advirtió en log
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Evento positivo [sent] de intento histórico (#1) recibido'),
        'WhatsAppStatusReconcilerService',
      );
    });

    it('evento positivo con transición rechazada (intento en RETRYABLE_REJECTION): no altera el mensaje', async () => {
      // Intento único en RETRYABLE_REJECTION esperando backoff para reintento
      const msg = {
        id: 'msg-rejected-trans-1',
        externalMessageId: 'wamid.INBOUND_REJ',
        status: 'RETRY_PENDING',
        attempts: 1,
        maxAttempts: 3,
        outboundMessageId: null,
      };

      mockPrisma.whatsAppSendAttempt.findFirst
        .mockResolvedValueOnce({
          id: 'attempt-rej-1',
          inboundMessageId: msg.id,
          attemptNumber: 1,
          status: 'RETRYABLE_REJECTION',
          outboundMessageId: 'wamid.REJ_OUT',
          inboundMessage: msg,
        })
        .mockResolvedValueOnce({
          id: 'attempt-rej-1',
          inboundMessageId: msg.id,
          attemptNumber: 1,
          status: 'RETRYABLE_REJECTION',
        });

      mockPrisma.whatsAppSendAttempt.findUnique.mockResolvedValueOnce({
        id: 'attempt-rej-1',
        inboundMessageId: msg.id,
        attemptNumber: 1,
        status: 'RETRYABLE_REJECTION',
        outboundMessageId: 'wamid.REJ_OUT',
        inboundMessage: msg,
      });

      mockPrisma.inboundMessage.updateMany.mockClear();

      const result = await service.ingestAndReconcile({
        id: 'wamid.REJ_OUT',
        status: 'sent',
        timestamp: '1726950950',
        recipient_id: '56912345678',
      });

      expect(result).toBe(true);

      // Transición rechazada: NO se modifica inboundMessage
      expect(mockPrisma.inboundMessage.updateMany).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Transición positiva SENT rechazada para intento [attempt-rej-1]'),
        'WhatsAppStatusReconcilerService',
      );
    });
  });
});
