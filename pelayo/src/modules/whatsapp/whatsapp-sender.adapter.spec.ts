import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../../common/logging/logger.service';
import { WhatsAppSenderAdapter } from './whatsapp-sender.adapter';

describe('WhatsAppSenderAdapter', () => {
  let adapter: WhatsAppSenderAdapter;
  let mockConfigService: Partial<ConfigService>;
  let mockLogger: Partial<AppLogger>;

  const mockApiUrl = 'https://graph.facebook.com/v21.0';
  const mockPhoneId = '10987654321';
  const mockApiToken = 'EAABtestingtoken12345';

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'WHATSAPP_API_URL') return mockApiUrl;
        if (key === 'WHATSAPP_PHONE_NUMBER_ID') return mockPhoneId;
        if (key === 'WHATSAPP_API_TOKEN') return mockApiToken;
        return defaultValue;
      }),
    };
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    adapter = new WhatsAppSenderAdapter(
      mockConfigService as ConfigService,
      mockLogger as AppLogger,
    );

    // Reset global fetch mock
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('debe retornar error CONFIG_ERROR si PHONE_NUMBER_ID o API_TOKEN no están configurados', async () => {
    (mockConfigService.get as jest.Mock).mockReturnValue('');
    const unconfiguredAdapter = new WhatsAppSenderAdapter(
      mockConfigService as ConfigService,
      mockLogger as AppLogger,
    );

    const result = await unconfiguredAdapter.sendTextMessage('+56912345678', 'Hola');
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('CONFIG_ERROR');
    expect(result.error).toContain('no están configurados');
  });

  it('debe enviar mensaje exitosamente mediante POST a Meta Cloud API', async () => {
    const metaResponse = {
      messaging_product: 'whatsapp',
      contacts: [{ input: '+56912345678', wa_id: '56912345678' }],
      messages: [{ id: 'wamid.HBgLM' }],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValueOnce(metaResponse),
    });

    const result = await adapter.sendTextMessage(
      '+56912345678',
      'Mensaje de prueba',
      'attempt-uuid-456',
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('wamid.HBgLM');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/10987654321/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mockApiToken}`,
        }),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '+56912345678',
          type: 'text',
          text: {
            preview_url: false,
            body: 'Mensaje de prueba',
          },
          biz_opaque_callback_data: 'attempt-uuid-456',
        }),
      }),
    );
  });

  it('no debe exponer el token de autorización en los logs', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValueOnce({ messages: [{ id: 'wamid.123' }] }),
    });

    await adapter.sendTextMessage('+56912345678', 'Hola');

    // Verificar que los logs de mockLogger nunca contengan el API Token
    const allLogCalls = (mockLogger.log as jest.Mock).mock.calls.flat();
    for (const logMsg of allLogCalls) {
      if (typeof logMsg === 'string') {
        expect(logMsg).not.toContain(mockApiToken);
      }
    }
  });

  it('debe clasificar errores 100/190 de Meta API como EXPLICIT_FATAL', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: jest.fn().mockResolvedValueOnce({
        error: {
          message: 'Unsupported post request',
          code: 100,
        },
      }),
    });

    const result = await adapter.sendTextMessage('+56912345678', 'Texto inválido');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('EXPLICIT_FATAL');
    expect(result.error).toContain('Meta API Error (100)');
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('debe clasificar errores 131016/500 de Meta API como EXPLICIT_RETRYABLE', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: jest.fn().mockResolvedValueOnce({
        error: {
          message: 'Service temporarily unavailable',
          code: 131016,
        },
      }),
    });

    const result = await adapter.sendTextMessage('+56912345678', 'Texto reintentable');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('EXPLICIT_RETRYABLE');
    expect(result.error).toContain('Meta API Error (131016)');
  });

  it('debe clasificar error 131030 (destinatario no permitido en sandbox) como EXPLICIT_FATAL', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: jest.fn().mockResolvedValueOnce({
        error: {
          message: 'Recipient phone number not in allowed list',
          code: 131030,
        },
      }),
    });

    const result = await adapter.sendTextMessage('+56912345678', 'Texto sandbox');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('EXPLICIT_FATAL');
    expect(result.error).toContain('131030');
    expect(result.error).toContain('lista de números permitidos');
  });

  it('debe clasificar error 131031 (cuenta bloqueada por Meta) como EXPLICIT_FATAL', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: jest.fn().mockResolvedValueOnce({
        error: {
          message: 'Account has been locked or restricted',
          code: 131031,
        },
      }),
    });

    const result = await adapter.sendTextMessage('+56912345678', 'Texto cuenta bloqueada');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('EXPLICIT_FATAL');
    expect(result.error).toContain('131031');
    expect(result.error).toContain('bloqueada');
  });

  it('debe clasificar respuesta HTTP 200 sin messageId como INVALID_RESPONSE', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValueOnce({
        messaging_product: 'whatsapp',
        contacts: [{ input: '+56912345678', wa_id: '56912345678' }],
        messages: [],
      }),
    });

    const result = await adapter.sendTextMessage('+56912345678', 'Texto sin ID');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('INVALID_RESPONSE');
    expect(result.error).toContain('sin message ID válido');
  });

  it('debe capturar timeouts defensivos de red como UNCERTAIN_TIMEOUT', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    (global.fetch as jest.Mock).mockRejectedValueOnce(timeoutError);

    const result = await adapter.sendTextMessage('+56912345678', 'Texto timeout');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('UNCERTAIN_TIMEOUT');
    expect(result.error).toContain('Timeout');
  });

  it('debe capturar errores de red no-timeout como NETWORK_ERROR', async () => {
    const netError = new Error('ECONNRESET: socket hang up');
    (global.fetch as jest.Mock).mockRejectedValueOnce(netError);

    const result = await adapter.sendTextMessage('+56912345678', 'Texto red');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('NETWORK_ERROR');
    expect(result.error).toContain('ECONNRESET');
  });
});
