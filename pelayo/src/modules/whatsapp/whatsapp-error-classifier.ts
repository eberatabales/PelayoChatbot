/**
 * Clasificador centralizado de errores de Meta Cloud API (WhatsApp Business API).
 * Compartido entre WhatsAppSenderAdapter y WhatsAppStatusReconcilerService (Sprint 2).
 *
 * Distingue explícitamente:
 * - EXPLICIT_FATAL: Errores que jamás deben reintentarse automáticamente (131030 sandbox, 131031 cuenta bloqueada, 131026 no entregable, 100 parámetro inválido, 190 token expirado).
 * - EXPLICIT_RETRYABLE: Errores transitorios de infraestructura o cuota (131016 no disponible, 131032 degradado, 80007 / 130429 rate limit, HTTP 429, 500/503).
 */

export type MetaErrorClassification = 'EXPLICIT_FATAL' | 'EXPLICIT_RETRYABLE';

export interface ClassifiedMetaError {
  classification: MetaErrorClassification;
  code?: number;
  httpStatus?: number;
  message: string;
  userFacingAction?: string;
  isFatal: boolean;
  isRetryable: boolean;
}

export interface MetaErrorClassificationInput {
  httpStatus?: number;
  metaCode?: number;
  rawMessage?: string;
}

export function classifyMetaError(
  inputOrCode?: number | MetaErrorClassificationInput,
  rawMessage?: string,
): ClassifiedMetaError {
  let httpStatus: number | undefined;
  let code: number | undefined;
  let msg = '';

  if (typeof inputOrCode === 'object' && inputOrCode !== null) {
    httpStatus = inputOrCode.httpStatus;
    code = inputOrCode.metaCode;
    msg = inputOrCode.rawMessage || '';
  } else {
    code = inputOrCode;
    msg = rawMessage || '';
  }

  // 131030: Recipient phone number not in allowed list for test mode (Sandbox restriction)
  if (code === 131030) {
    return {
      classification: 'EXPLICIT_FATAL',
      code,
      httpStatus,
      message: `Meta API Error (131030): El destinatario no está incluido en la lista de números permitidos para el entorno de prueba de Meta.`,
      userFacingAction:
        'Agregar el número de teléfono del destinatario a la lista de prueba en Meta for Developers.',
      isFatal: true,
      isRetryable: false,
    };
  }

  // 131031: Account is restricted or locked by Meta
  if (code === 131031) {
    return {
      classification: 'EXPLICIT_FATAL',
      code,
      httpStatus,
      message: `Meta API Error (131031): La cuenta de WhatsApp Business se encuentra bloqueada o con restricciones de pago/políticas.`,
      userFacingAction: 'Revisar y regularizar el estado de la cuenta en Meta Business Manager.',
      isFatal: true,
      isRetryable: false,
    };
  }

  // 131026: Message undeliverable (phone number not active on WhatsApp or rejected delivery)
  if (code === 131026) {
    return {
      classification: 'EXPLICIT_FATAL',
      code,
      httpStatus,
      message: `Meta API Error (131026): El mensaje no pudo ser entregado al destinatario (número no registrado en WhatsApp o entrega rechazada).`,
      userFacingAction:
        'Verificar que el número de teléfono pertenezca a un usuario activo de WhatsApp.',
      isFatal: true,
      isRetryable: false,
    };
  }

  // 100: Invalid parameter / payload structure
  if (code === 100) {
    return {
      classification: 'EXPLICIT_FATAL',
      code,
      httpStatus,
      message: `Meta API Error (100): Parámetro inválido o formato de mensaje no soportado.`,
      userFacingAction: 'Verificar los parámetros del mensaje enviados a Meta Cloud API.',
      isFatal: true,
      isRetryable: false,
    };
  }

  // 190: Access token expired or invalid
  if (code === 190) {
    return {
      classification: 'EXPLICIT_FATAL',
      code,
      httpStatus,
      message: `Meta API Error (190): Token de acceso inválido o expirado.`,
      userFacingAction: 'Renovar el token de acceso en WHATSAPP_API_TOKEN.',
      isFatal: true,
      isRetryable: false,
    };
  }

  // Explicit retryable Meta error codes:
  // 131016: Service temporarily unavailable
  // 131032: Payment issue / rate limit / degraded service
  // 80007 / 130429: Rate limit exceeded
  // 500 / 503 / 131000: Internal server error / temporary glitch
  if (
    code === 131016 ||
    code === 131032 ||
    code === 80007 ||
    code === 130429 ||
    code === 131000 ||
    code === 500 ||
    code === 503
  ) {
    return {
      classification: 'EXPLICIT_RETRYABLE',
      code,
      httpStatus,
      message: `Meta API Error (${code}): Servicio temporalmente no disponible o límite de tasa alcanzado.`,
      userFacingAction: 'Reintento automático programado con backoff progresivo.',
      isFatal: false,
      isRetryable: true,
    };
  }

  // HTTP status evaluation if provided
  if (httpStatus) {
    if (httpStatus === 429) {
      return {
        classification: 'EXPLICIT_RETRYABLE',
        code,
        httpStatus,
        message: `Meta API HTTP 429: Límite de peticiones excedido (Rate Limit).`,
        userFacingAction: 'Reintento automático programado con backoff progresivo.',
        isFatal: false,
        isRetryable: true,
      };
    }
    if (httpStatus >= 500) {
      return {
        classification: 'EXPLICIT_RETRYABLE',
        code,
        httpStatus,
        message: `Meta API HTTP ${httpStatus}: Error interno del servidor en Meta API (${msg || 'Servicio no disponible'}).`,
        userFacingAction: 'Reintento automático programado con backoff progresivo.',
        isFatal: false,
        isRetryable: true,
      };
    }
    if (httpStatus >= 400 && httpStatus < 500) {
      return {
        classification: 'EXPLICIT_FATAL',
        code,
        httpStatus,
        message: `Meta API HTTP ${httpStatus}: ${msg || 'Error de cliente en la petición a Meta'}`,
        userFacingAction: 'Revisar la configuración o payload de la petición.',
        isFatal: true,
        isRetryable: false,
      };
    }
  }

  // Fallback for 4xx vs 5xx if code looks like HTTP status
  if (code && code >= 400 && code < 500) {
    return {
      classification: 'EXPLICIT_FATAL',
      code,
      httpStatus,
      message: `Meta API Error (${code}): ${msg || 'Error de cliente en la petición a Meta'}`,
      isFatal: true,
      isRetryable: false,
    };
  }

  return {
    classification: 'EXPLICIT_RETRYABLE',
    code,
    httpStatus,
    message: `Meta API Error (${code || 'desconocido'}): ${msg || 'Falla temporal de servicio'}`,
    isFatal: false,
    isRetryable: true,
  };
}
