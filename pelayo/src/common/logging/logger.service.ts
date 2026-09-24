import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';

/**
 * Fuente canónica unificada de patrones para claves sensibles.
 * Se utiliza de forma idéntica tanto para propiedades de objetos
 * como para pares clave-valor dentro de cadenas de texto.
 */
export const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret[_-]?key',
  'client[_-]?secret',
  'secret',
  'token',
  'api[_-]?key',
  'access[_-]?key',
  'access[_-]?token',
  'private[_-]?key',
  'authorization',
  'cookie',
  'credentials?',
  'database_url',
] as const;

// Ordenamos de mayor a menor longitud para que patrones específicos (ej: secret_key)
// tengan precedencia sobre patrones más cortos (ej: secret) en la alternancia regex.
const SENSITIVE_PATTERN_STRING = [...SENSITIVE_KEY_PATTERNS]
  .sort((a, b) => b.length - a.length)
  .join('|');

export const SENSITIVE_KEY_REGEX = new RegExp(`(?:${SENSITIVE_PATTERN_STRING})`, 'i');

const QUOTED_PAIR_REGEX = new RegExp(
  `(${SENSITIVE_PATTERN_STRING})(["']?\\s*[:=]\\s*)(["'])(.*?)\\3`,
  'gi',
);

const UNQUOTED_PAIR_REGEX = new RegExp(
  `(${SENSITIVE_PATTERN_STRING})(\\s*[:=]\\s*)([^\\s"'&,;]+)`,
  'gi',
);

/**
 * Sanitiza cadenas de texto para ocultar contraseñas en URLs de conexión,
 * tokens Bearer y pares clave: valor o clave=valor (con comillas y sin comillas).
 */
export function redactSensitiveString(text: string): string {
  if (!text || typeof text !== 'string') {
    return text;
  }

  return (
    text
      // 1. Ocultar contraseñas en URLs (ej: postgresql://user:pass@host:port/db)
      .replace(/([a-zA-Z0-9+.-]+:\/\/[^/\\:\s@]+:)([^@\s/]+)(@[^/\\:\s]+)/gi, '$1[REDACTED]$3')
      // 2. Ocultar Bearer tokens
      .replace(/(bearer\s+)[a-zA-Z0-9_\-.]+/gi, '$1[REDACTED]')
      // 3. Pares clave=valor o clave: valor con comillas (permite espacios internos)
      .replace(QUOTED_PAIR_REGEX, '$1$2$3[REDACTED]$3')
      // 4. Pares clave=valor o clave: valor sin comillas
      .replace(UNQUOTED_PAIR_REGEX, '$1$2[REDACTED]')
  );
}

/**
 * Recorre recursivamente objetos, arreglos, errores y strings para redactar secretos.
 */
export function redactSensitiveData(data: unknown): unknown {
  if (!data) {
    return data;
  }

  if (typeof data === 'string') {
    return redactSensitiveString(data);
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: redactSensitiveString(data.message),
      stack: data.stack
        ? data.stack.split('\n').map((line) => redactSensitiveString(line))
        : undefined,
    };
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(redactSensitiveData);
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const isSensitive = SENSITIVE_KEY_REGEX.test(key);

    if (isSensitive) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redactSensitiveData(value);
    }
  }

  return redacted;
}

@Injectable()
export class AppLogger implements NestLoggerService {
  public formatMessage(level: string, message: unknown, context?: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const isProd = process.env.NODE_ENV === 'production';
    // Aplica redacción recursiva integral tanto si message es string, Error u objeto estructurado
    const sanitizedMessage = redactSensitiveData(message);

    const payload = {
      timestamp,
      level,
      context: context || 'Application',
      message: sanitizedMessage,
      ...(data ? { data: redactSensitiveData(data) } : {}),
    };

    if (isProd) {
      return JSON.stringify(payload);
    }

    const ctx = context ? `[${context}] ` : '';
    const msgStr =
      typeof sanitizedMessage === 'object' && sanitizedMessage !== null
        ? JSON.stringify(sanitizedMessage)
        : String(sanitizedMessage);
    const extra = data ? ` | ${JSON.stringify(redactSensitiveData(data))}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${ctx}${msgStr}${extra}`;
  }

  log(message: unknown, context?: string, data?: unknown) {
    console.log(this.formatMessage('info', message, context, data));
  }

  error(message: unknown, trace?: string, context?: string, data?: unknown) {
    const sanitizedTrace = trace
      ? trace.split('\n').map((line) => redactSensitiveString(line))
      : undefined;

    console.error(
      this.formatMessage('error', message, context, {
        ...(data && typeof data === 'object' ? data : {}),
        trace: sanitizedTrace,
      }),
    );
  }

  warn(message: unknown, context?: string, data?: unknown) {
    console.warn(this.formatMessage('warn', message, context, data));
  }

  debug(message: unknown, context?: string, data?: unknown) {
    if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV !== 'production') {
      console.debug(this.formatMessage('debug', message, context, data));
    }
  }

  verbose(message: unknown, context?: string, data?: unknown) {
    if (process.env.LOG_LEVEL === 'trace') {
      console.log(this.formatMessage('verbose', message, context, data));
    }
  }
}
