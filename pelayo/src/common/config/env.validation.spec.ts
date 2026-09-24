import { validateEnvironment } from './env.validation';

describe('validateEnvironment', () => {
  it('debe validar exitosamente una configuración válida con postgresql://', () => {
    const validConfig = {
      NODE_ENV: 'development',
      PORT: '3000',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
      LOG_LEVEL: 'info',
    };

    const validated = validateEnvironment(validConfig);
    expect(validated.NODE_ENV).toBe('development');
    expect(validated.PORT).toBe(3000);
    expect(validated.DATABASE_URL).toBe(validConfig.DATABASE_URL);
    expect(validated.WHATSAPP_VERIFY_TOKEN).toBe('pelayo_bot_test_verify_token_2026');
  });

  it('debe validar exitosamente una configuración válida con postgres://', () => {
    const validConfig = {
      PORT: '8080',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    };

    const validated = validateEnvironment(validConfig);
    expect(validated.PORT).toBe(8080);
    expect(validated.DATABASE_URL).toBe(validConfig.DATABASE_URL);
  });

  it('debe fallar si DATABASE_URL es una URL HTTPS en vez de PostgreSQL', () => {
    const invalidConfig = {
      PORT: '3000',
      DATABASE_URL: 'https://example.com/database',
    };

    expect(() => validateEnvironment(invalidConfig)).toThrow(
      'DATABASE_URL must use the postgresql:// or postgres:// protocol',
    );
  });

  it('debe fallar si DATABASE_URL no es una URL válida', () => {
    const invalidConfig = {
      PORT: '3000',
      DATABASE_URL: 'not-a-url',
    };

    expect(() => validateEnvironment(invalidConfig)).toThrow('DATABASE_URL must be a valid URL');
  });

  it('debe rechazar PORT="3000oops" con error de dígitos enteros', () => {
    const invalidConfig = {
      PORT: '3000oops',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    };

    expect(() => validateEnvironment(invalidConfig)).toThrow(
      'PORT must be an integer string containing only digits',
    );
  });

  it('debe rechazar PORT="3000.5" con decimales', () => {
    const invalidConfig = {
      PORT: '3000.5',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    };

    expect(() => validateEnvironment(invalidConfig)).toThrow(
      'PORT must be an integer string containing only digits',
    );
  });

  it('debe rechazar PORT fuera de rango como 0 o 70000', () => {
    expect(() =>
      validateEnvironment({
        PORT: '0',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      }),
    ).toThrow('PORT must be a valid integer between 1 and 65535');

    expect(() =>
      validateEnvironment({
        PORT: '70000',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      }),
    ).toThrow('PORT must be a valid integer between 1 and 65535');
  });

  describe('Validación estricta de WhatsApp en producción', () => {
    it('debe rechazar configuración en producción si faltan credenciales de WhatsApp o son placeholders', () => {
      const prodConfig = {
        NODE_ENV: 'production',
        PORT: '3000',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      };

      expect(() => validateEnvironment(prodConfig)).toThrow('En producción');
    });

    it('debe rechazar configuración en producción si se usan secretos de prueba conocidos', () => {
      const prodConfig = {
        NODE_ENV: 'production',
        PORT: '3000',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        WHATSAPP_VERIFY_TOKEN: 'token_valido_de_mas_de_16_caracteres',
        WHATSAPP_APP_SECRET: 'test_app_secret_inseguro_32_chars',
        WHATSAPP_API_TOKEN: 'EAAB_token_real_de_produccion_12345',
        WHATSAPP_PHONE_NUMBER_ID: '109876543210987',
      };

      expect(() => validateEnvironment(prodConfig)).toThrow(
        'no puede usar secretos de prueba predeterminados',
      );
    });

    it('debe aceptar configuración de producción cuando se proveen credenciales reales y seguras', () => {
      const prodConfig = {
        NODE_ENV: 'production',
        PORT: '3000',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        WHATSAPP_VERIFY_TOKEN: 'prod_verify_secret_token_seguro_2026',
        WHATSAPP_APP_SECRET: 'a1b2c3d4e5f67890abcdef1234567890',
        WHATSAPP_API_TOKEN: 'EAAG_prod_access_token_real_meta_cloud_api',
        WHATSAPP_PHONE_NUMBER_ID: '109876543210987',
      };

      const validated = validateEnvironment(prodConfig);
      expect(validated.NODE_ENV).toBe('production');
      expect(validated.WHATSAPP_VERIFY_TOKEN).toBe('prod_verify_secret_token_seguro_2026');
      expect(validated.WHATSAPP_PHONE_NUMBER_ID).toBe('109876543210987');
    });
  });
});
