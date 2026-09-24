import { redactSensitiveData, redactSensitiveString, AppLogger } from './logger.service';

describe('Logger Secret Redaction', () => {
  describe('redactSensitiveString', () => {
    it('debe redactar credenciales en URLs de base de datos dentro de cadenas de texto', () => {
      const rawString =
        'Error connecting to postgresql://pelayo_user:super_secret_pw@localhost:5432/pelayodb?schema=public';
      const sanitized = redactSensitiveString(rawString);

      expect(sanitized).toBe(
        'Error connecting to postgresql://pelayo_user:[REDACTED]@localhost:5432/pelayodb?schema=public',
      );
      expect(sanitized).not.toContain('super_secret_pw');
    });

    it('debe redactar tokens Bearer en cadenas de texto', () => {
      const rawString = 'Authorization header: Bearer eaab123456789xyz.payload';
      const sanitized = redactSensitiveString(rawString);

      expect(sanitized).toBe('Authorization header: Bearer [REDACTED]');
      expect(sanitized).not.toContain('eaab123456789xyz');
    });

    it('debe redactar contraseñas y tokens con espacios entre comillas completas', () => {
      const rawString = 'Failed with password="first second" and token=\'another secret phrase\'';
      const sanitized = redactSensitiveString(rawString);

      expect(sanitized).toBe('Failed with password="[REDACTED]" and token=\'[REDACTED]\'');
      expect(sanitized).not.toContain('first');
      expect(sanitized).not.toContain('second');
      expect(sanitized).not.toContain('another');
    });

    it('debe redactar access_key de forma unificada tanto entrecomillado como sin comillas en texto', () => {
      const rawString = 'AWS config: access_key=AKIAIOSFODNN7EXAMPLE, secret_key="with spaces key"';
      const sanitized = redactSensitiveString(rawString);

      expect(sanitized).toBe('AWS config: access_key=[REDACTED], secret_key="[REDACTED]"');
      expect(sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(sanitized).not.toContain('with spaces key');
    });

    it('debe redactar pares clave-valor sin comillas', () => {
      const rawString = 'Config check: password=singleSecretVal, api_key=secretKey123';
      const sanitized = redactSensitiveString(rawString);

      expect(sanitized).toBe('Config check: password=[REDACTED], api_key=[REDACTED]');
      expect(sanitized).not.toContain('singleSecretVal');
      expect(sanitized).not.toContain('secretKey123');
    });
  });

  describe('redactSensitiveData', () => {
    it('debe redactar campos con api_key, access_key, password, token en objetos anidados', () => {
      const input = {
        user: 'test_user',
        api_key: 'sk_live_123456789abcdef',
        apiKey: 'sk_test_987654321',
        access_key: 'AKIA1234567890EXAMPLE',
        password: 'super_secret_password',
        token: 'bearer_token_12345',
        whatsapp_api_token: 'meta_secret_token',
        database_url: 'postgresql://admin:secret@localhost:5432/db',
        nested: {
          api_secret: 'nested_secret',
          safe_field: 'ok',
          connection_error: 'Failed at postgresql://app_user:db_pass@db.local:5432/main',
        },
      };

      const output = redactSensitiveData(input) as Record<string, unknown>;
      const nested = output.nested as Record<string, unknown>;

      expect(output.user).toBe('test_user');
      expect(output.api_key).toBe('[REDACTED]');
      expect(output.apiKey).toBe('[REDACTED]');
      expect(output.access_key).toBe('[REDACTED]');
      expect(output.password).toBe('[REDACTED]');
      expect(output.token).toBe('[REDACTED]');
      expect(output.whatsapp_api_token).toBe('[REDACTED]');
      expect(output.database_url).toBe('[REDACTED]');
      expect(nested.api_secret).toBe('[REDACTED]');
      expect(nested.safe_field).toBe('ok');
      expect(nested.connection_error).toBe(
        'Failed at postgresql://app_user:[REDACTED]@db.local:5432/main',
      );
    });

    it('debe manejar arrays con objetos sensibles', () => {
      const input = [
        { id: 1, password: 'secret1', api_key: 'key1' },
        { id: 2, password: 'secret2', api_key: 'key2' },
      ];

      const output = redactSensitiveData(input) as Array<Record<string, unknown>>;

      expect(output[0].password).toBe('[REDACTED]');
      expect(output[0].api_key).toBe('[REDACTED]');
      expect(output[1].password).toBe('[REDACTED]');
      expect(output[1].api_key).toBe('[REDACTED]');
    });
  });

  describe('Protección de mensajes estructurados (AppLogger)', () => {
    it('debe redactar mensajes estructurados cuando message es un objeto en producción', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const logger = new AppLogger();
      const output = logger.formatMessage('info', {
        token: 'super_secret_session_token',
        access_key: 'AKIAEXAMPLE1234',
        safe_info: 'some_public_data',
      });

      process.env.NODE_ENV = originalEnv;

      const parsed = JSON.parse(output);
      expect(parsed.message.token).toBe('[REDACTED]');
      expect(parsed.message.access_key).toBe('[REDACTED]');
      expect(parsed.message.safe_info).toBe('some_public_data');
      expect(output).not.toContain('super_secret_session_token');
      expect(output).not.toContain('AKIAEXAMPLE1234');
    });

    it('debe redactar mensajes cuando message es una instancia de Error', () => {
      const logger = new AppLogger();
      const error = new Error('Database crashed: password="my_db_password"');

      const output = logger.formatMessage('error', error);

      expect(output).not.toContain('my_db_password');
      expect(output).toContain('[REDACTED]');
    });

    it('debe redactar secretos en los textos del stack trace y message', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const logger = new AppLogger();

      const rawMessage =
        'Fatal DB crash at postgresql://user:my_secret_pass@127.0.0.1:5432/db with password="multi word pass"';
      const rawTrace =
        'Error: Connection failed\n  at postgresql://user:my_secret_pass@127.0.0.1:5432';

      logger.error(rawMessage, rawTrace, 'TestContext');

      expect(consoleSpy).toHaveBeenCalled();
      const loggedArg = consoleSpy.mock.calls[0][0];

      expect(loggedArg).not.toContain('my_secret_pass');
      expect(loggedArg).not.toContain('multi word pass');
      expect(loggedArg).toContain('[REDACTED]');

      consoleSpy.mockRestore();
    });
  });
});
