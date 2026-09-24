import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { AppLogger } from '../../common/logging/logger.service';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';

describe('WhatsAppSignatureGuard', () => {
  let guard: WhatsAppSignatureGuard;
  let mockConfigService: Partial<ConfigService>;
  let mockLogger: Partial<AppLogger>;

  const testSecret = 'my_super_secret_whatsapp_key';

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'WHATSAPP_APP_SECRET') return testSecret;
        return undefined;
      }),
    };
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    guard = new WhatsAppSignatureGuard(mockConfigService as ConfigService, mockLogger as AppLogger);
  });

  function createMockContext(headers: Record<string, string>, rawBody?: Buffer): ExecutionContext {
    const request = {
      headers,
      rawBody,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it('debe lanzar UnauthorizedException si WHATSAPP_APP_SECRET no está configurado', () => {
    (mockConfigService.get as jest.Mock).mockReturnValue(undefined);
    const context = createMockContext({});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('WhatsApp app secret is not configured');
  });

  it('debe lanzar UnauthorizedException si falta la cabecera x-hub-signature-256', () => {
    const context = createMockContext({});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Missing x-hub-signature-256 header');
  });

  it('debe lanzar UnauthorizedException si la cabecera no empieza con sha256=', () => {
    const context = createMockContext({
      'x-hub-signature-256': 'md5=abcdef123456',
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Invalid signature format');
  });

  it('debe lanzar UnauthorizedException si rawBody no está disponible en la petición', () => {
    const context = createMockContext({ 'x-hub-signature-256': 'sha256=abcdef123456' }, undefined);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Raw body unavailable');
  });

  it('debe lanzar UnauthorizedException si la firma HMAC calculada no coincide con la cabecera', () => {
    const payload = Buffer.from(JSON.stringify({ test: 'invalid' }));
    const badHash = crypto.createHmac('sha256', 'wrong_secret').update(payload).digest('hex');

    const context = createMockContext({ 'x-hub-signature-256': `sha256=${badHash}` }, payload);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Invalid WhatsApp signature');
  });

  it('debe retornar true cuando la firma HMAC-SHA256 coincide exactamente', () => {
    const payload = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
    const validHash = crypto.createHmac('sha256', testSecret).update(payload).digest('hex');

    const context = createMockContext({ 'x-hub-signature-256': `sha256=${validHash}` }, payload);

    const result = guard.canActivate(context);
    expect(result).toBe(true);
  });
});
