import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../../common/logging/logger.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhookPayload } from './whatsapp.types';

describe('WhatsAppController', () => {
  let controller: WhatsAppController;
  let mockService: Partial<WhatsAppService>;
  let mockConfigService: Partial<ConfigService>;
  let mockLogger: Partial<AppLogger>;

  const testVerifyToken = 'pelayo_webhook_secret_verify_token';

  beforeEach(() => {
    mockService = {
      handleWebhook: jest.fn(),
    };
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'WHATSAPP_VERIFY_TOKEN') return testVerifyToken;
        return undefined;
      }),
    };
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    controller = new WhatsAppController(
      mockService as WhatsAppService,
      mockConfigService as ConfigService,
      mockLogger as AppLogger,
    );
  });

  describe('verifyWebhook (GET)', () => {
    it('debe retornar el hub.challenge cuando el token y el modo son correctos', () => {
      const result = controller.verifyWebhook('subscribe', testVerifyToken, 'challenge_code_12345');

      expect(result).toBe('challenge_code_12345');
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('verificado con éxito'),
        'WhatsAppController',
      );
    });

    it('debe lanzar ForbiddenException cuando el verify_token es incorrecto', () => {
      expect(() =>
        controller.verifyWebhook('subscribe', 'wrong_token', 'challenge_code_12345'),
      ).toThrow(ForbiddenException);
    });

    it('debe lanzar ForbiddenException cuando hub.mode no es subscribe', () => {
      expect(() =>
        controller.verifyWebhook('unsubscribe', testVerifyToken, 'challenge_code_12345'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('handleIncomingWebhook (POST) - S2.03-A Validación y tratamiento de errores', () => {
    const validPayload: WhatsAppWebhookPayload = {
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
                messages: [
                  {
                    from: '56912345678',
                    id: 'wamid.123',
                    timestamp: '1726950000',
                    type: 'text',
                    text: { body: 'Hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    it('procesa exitosamente un payload estructuralmente válido y devuelve 200', async () => {
      const mockResult = {
        processed: 1,
        duplicates: 0,
        ignored: 0,
        errors: 0,
        details: [{ status: 'PROCESSED' as const }],
      };

      (mockService.handleWebhook as jest.Mock).mockResolvedValueOnce(mockResult);

      const response = await controller.handleIncomingWebhook(validPayload);

      expect(response).toEqual({
        status: 'success',
        ...mockResult,
      });
      expect(mockService.handleWebhook).toHaveBeenCalledWith(validPayload);
    });

    it('S2.03-A: rechaza con BadRequestException (HTTP 400) payloads malformados sin object esperado', async () => {
      const malformedPayload = {
        object: 'invalid_object_type',
        entry: [],
      } as unknown as WhatsAppWebhookPayload;

      await expect(controller.handleIncomingWebhook(malformedPayload)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockService.handleWebhook).not.toHaveBeenCalled();
    });

    it('S2.03-A: rechaza con BadRequestException (HTTP 400) si entry está vacío o falta', async () => {
      const malformedPayload = {
        object: 'whatsapp_business_account',
      } as unknown as WhatsAppWebhookPayload;

      await expect(controller.handleIncomingWebhook(malformedPayload)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockService.handleWebhook).not.toHaveBeenCalled();
    });

    it('S2.03-A: propaga InternalServerErrorException si la persistencia en DB falla (HTTP 500 para reintento de Meta)', async () => {
      (mockService.handleWebhook as jest.Mock).mockRejectedValueOnce(
        new InternalServerErrorException('Error de persistencia en base de datos'),
      );

      await expect(controller.handleIncomingWebhook(validPayload)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });
});
