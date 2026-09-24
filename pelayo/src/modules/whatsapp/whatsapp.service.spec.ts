import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppLogger } from '../../common/logging/logger.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppStatusReconcilerService } from './whatsapp-status-reconciler.service';
import { WhatsAppRawMessage, WhatsAppRawStatus, WhatsAppWebhookPayload } from './whatsapp.types';

describe('WhatsAppService', () => {
  let service: WhatsAppService;
  let mockPrisma: {
    inboundMessage: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let mockQueueProcessor: Partial<WhatsAppQueueProcessor>;
  let mockStatusReconciler: Partial<WhatsAppStatusReconcilerService>;
  let mockLogger: Partial<AppLogger>;

  beforeEach(() => {
    mockPrisma = {
      inboundMessage: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    mockQueueProcessor = {
      trigger: jest.fn(),
      processRecord: jest.fn(),
      processPendingQueue: jest.fn(),
    };
    mockStatusReconciler = {
      ingestAndReconcile: jest.fn().mockResolvedValue(true),
    };
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    service = new WhatsAppService(
      mockPrisma as unknown as PrismaService,
      mockQueueProcessor as WhatsAppQueueProcessor,
      mockStatusReconciler as WhatsAppStatusReconcilerService,
      mockLogger as AppLogger,
    );
  });

  const createSamplePayload = (
    messages?: WhatsAppRawMessage[],
    statuses?: WhatsAppRawStatus[],
  ): WhatsAppWebhookPayload => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456789',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+56911112222',
                phone_number_id: '10987654321',
              },
              messages,
              statuses,
            },
          },
        ],
      },
    ],
  });

  describe('Ingesta y Durabilidad (S2.08-A)', () => {
    it('debe persistir atómicamente un mensaje y activar el procesador de cola durable', async () => {
      const rawMsg = {
        from: '56912345678',
        id: 'wamid.HBgLMS4w',
        timestamp: '1726950000',
        type: 'text',
        text: { body: 'Hola, tienen stock?' },
      };

      const payload = createSamplePayload([rawMsg]);

      mockPrisma.inboundMessage.create.mockResolvedValueOnce({
        id: 'internal-uuid-1',
        externalMessageId: 'wamid.HBgLMS4w',
        fromPhone: '56912345678',
        status: 'RECEIVED',
      });

      const result = await service.handleWebhook(payload);

      expect(result.processed).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.errors).toBe(0);
      expect(mockPrisma.inboundMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            externalMessageId: 'wamid.HBgLMS4w',
            content: 'Hola, tienen stock?',
            messageType: 'text',
            status: 'RECEIVED',
          }),
        }),
      );
      expect(mockQueueProcessor.trigger).toHaveBeenCalledTimes(1);
    });

    it('debe lanzar InternalServerErrorException si PostgreSQL falla al insertar (para que Meta reintente)', async () => {
      const rawMsg = {
        from: '56912345678',
        id: 'wamid.DB_FAIL',
        timestamp: '1726950000',
        type: 'text',
        text: { body: 'Mensaje crítico' },
      };

      const payload = createSamplePayload([rawMsg]);

      mockPrisma.inboundMessage.create.mockRejectedValueOnce(
        new Error('Connection lost to PostgreSQL'),
      );

      await expect(service.handleWebhook(payload)).rejects.toThrow(InternalServerErrorException);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Fallo crítico de persistencia'),
        expect.anything(),
        'WhatsAppService',
      );
      expect(mockQueueProcessor.trigger).not.toHaveBeenCalled();
    });

    it('debe descartar mensajes duplicados que ya fueron procesados con éxito (PROCESSED)', async () => {
      const rawMsg = {
        from: '56912345678',
        id: 'wamid.DUPLICATE_DONE',
        timestamp: '1726950000',
        type: 'text',
        text: { body: 'Mensaje ya respondido' },
      };

      const payload = createSamplePayload([rawMsg]);

      const p2002Error = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on external_message_id',
        {
          code: 'P2002',
          clientVersion: '6.0.0',
        },
      );

      mockPrisma.inboundMessage.create.mockRejectedValueOnce(p2002Error);
      mockPrisma.inboundMessage.findUnique.mockResolvedValueOnce({
        id: 'uuid-existing',
        externalMessageId: 'wamid.DUPLICATE_DONE',
        status: 'PROCESSED',
      });

      const result = await service.handleWebhook(payload);

      expect(result.processed).toBe(0);
      expect(result.duplicates).toBe(1);
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Mensaje duplicado descartado (ya procesado exitosamente)'),
        'WhatsAppService',
      );
    });

    it('debe admitir reintento si el mensaje existente quedó en FAILED o RECEIVED', async () => {
      const rawMsg = {
        from: '56912345678',
        id: 'wamid.RETRY_ME',
        timestamp: '1726950000',
        type: 'text',
        text: { body: 'Mensaje que falló antes' },
      };

      const payload = createSamplePayload([rawMsg]);

      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.0.0',
      });

      mockPrisma.inboundMessage.create.mockRejectedValueOnce(p2002Error);
      mockPrisma.inboundMessage.findUnique.mockResolvedValueOnce({
        id: 'uuid-failed-prev',
        externalMessageId: 'wamid.RETRY_ME',
        status: 'FAILED',
        responseSent: false,
      });

      const result = await service.handleWebhook(payload);

      expect(result.processed).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(mockQueueProcessor.trigger).toHaveBeenCalledTimes(1);
    });

    it('debe registrar statuses de entrega como IGNORED sin intentar responder', async () => {
      const statusMsg = {
        id: 'wamid.ORIGINAL',
        status: 'delivered',
        timestamp: '1726950001',
        recipient_id: '56912345678',
      };

      const payload = createSamplePayload(undefined, [statusMsg]);

      const result = await service.handleWebhook(payload);

      expect(result.ignored).toBe(1);
      expect(mockPrisma.inboundMessage.create).not.toHaveBeenCalled();
      expect(mockQueueProcessor.trigger).not.toHaveBeenCalled();
    });
  });

  describe('S2.04-A: Completar normalización de interactivos y referrals', () => {
    it('normaliza correctamente respuestas interactivas de botón (button_reply)', () => {
      const rawMsg: WhatsAppRawMessage = {
        id: 'wamid.BTN_01',
        from: '56911223344',
        timestamp: '1726950010',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: {
            id: 'btn_ver_catalogo',
            title: 'Ver Catálogo',
          },
        },
      };

      const normalized = service.normalizeRawMessage(rawMsg);

      expect(normalized.externalMessageId).toBe('wamid.BTN_01');
      expect(normalized.fromPhone).toBe('56911223344');
      expect(normalized.messageType).toBe('interactive');
      expect(normalized.content).toBe('Ver Catálogo');
      expect(normalized.interactive).toEqual({
        type: 'button_reply',
        id: 'btn_ver_catalogo',
        title: 'Ver Catálogo',
      });
    });

    it('normaliza correctamente respuestas interactivas de lista (list_reply)', () => {
      const rawMsg: WhatsAppRawMessage = {
        id: 'wamid.LIST_01',
        from: '56911223344',
        timestamp: '1726950020',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: 'item_mazda_3',
            title: 'Mazda 3 2020',
            description: 'Sedán automático 2.0',
          },
        },
      };

      const normalized = service.normalizeRawMessage(rawMsg);

      expect(normalized.messageType).toBe('interactive');
      expect(normalized.content).toBe('Mazda 3 2020');
      expect(normalized.interactive).toEqual({
        type: 'list_reply',
        id: 'item_mazda_3',
        title: 'Mazda 3 2020',
        description: 'Sedán automático 2.0',
      });
    });

    it('normaliza correctamente datos de referral (origen publicitario/enlace)', () => {
      const rawMsg: WhatsAppRawMessage = {
        id: 'wamid.REF_01',
        from: '56911223344',
        timestamp: '1726950030',
        type: 'text',
        text: { body: 'Hola vi este auto' },
        referral: {
          source_url: 'https://fb.me/ad123',
          source_type: 'ad',
          source_id: 'ad_987654',
          headline: 'Mazda 3 2020 en oferta',
          body: 'Conoce nuestro catálogo',
        },
      };

      const normalized = service.normalizeRawMessage(rawMsg);

      expect(normalized.referral).toBeDefined();
      expect(normalized.referral?.sourceUrl).toBe('https://fb.me/ad123');
      expect(normalized.referral?.sourceType).toBe('ad');
      expect(normalized.referral?.headline).toBe('Mazda 3 2020 en oferta');
    });
  });

  describe('Delegación de despacho y recuperación', () => {
    it('dispatchSingleRecord delega en queueProcessor.processRecord', async () => {
      (mockQueueProcessor.processRecord as jest.Mock).mockResolvedValueOnce(true);

      const res = await service.dispatchSingleRecord('record-1');

      expect(res).toBe(true);
      expect(mockQueueProcessor.processRecord).toHaveBeenCalledWith('record-1');
    });

    it('recoverPendingMessages delega en queueProcessor.processPendingQueue', async () => {
      (mockQueueProcessor.processPendingQueue as jest.Mock).mockResolvedValueOnce(5);

      const res = await service.recoverPendingMessages();

      expect(res).toBe(5);
      expect(mockQueueProcessor.processPendingQueue).toHaveBeenCalled();
    });
  });

  describe('Reconciliación de eventos de estado (statuses - S2.09-B)', () => {
    it('debe enviar eventos de estado a statusReconciler.ingestAndReconcile', async () => {
      const rawStatus: WhatsAppRawStatus = {
        id: 'wamid.HBgLTestOutbound',
        status: 'delivered',
        timestamp: '1726950100',
        recipient_id: '56912345678',
      };

      const payload = createSamplePayload(undefined, [rawStatus]);
      const result = await service.handleWebhook(payload);

      expect(mockStatusReconciler.ingestAndReconcile).toHaveBeenCalledWith(rawStatus);
      expect(result.ignored).toBe(1);
      expect(result.details[0].externalMessageId).toBe('wamid.HBgLTestOutbound');
    });
  });
});
