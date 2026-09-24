import { InboundMessageStatus, WhatsAppSendAttemptStatus } from './whatsapp.types';

/**
 * Política centralizada de transiciones de estado para WhatsApp (Sprint 2 - S2.09-B).
 *
 * Principios:
 * 1. Separación estricta entre estado de transporte HTTP y estado real de entrega reportado por Meta.
 * 2. Inmutabilidad de la entrega confirmada: Si un intento ya alcanzó DELIVERED o READ,
 *    ningún evento posterior de falla o contradictorio puede degradar la confirmación.
 * 3. Coherencia integral de deliveryUncertain: Se limpia (false) sistemáticamente cuando
 *    la evidencia de transporte o de webhook resuelve la incertidumbre.
 * 4. Actualizaciones condicionales atómicas con verificación de count === 1.
 */
export class WhatsAppStateTransitionPolicy {
  /**
   * Estados del intento que representan una entrega física confirmada en el dispositivo.
   * Estos estados son inmutables frente a eventos de falla tardíos o contradictorios.
   */
  static readonly CONFIRMED_DELIVERY_ATTEMPT_STATES: string[] = ['DELIVERED', 'READ'];

  /**
   * Estados desde los cuales el worker puede transicionar el mensaje a PROCESSED tras recibir HTTP 200 con wamid.
   * NUNCA incluye FAILED_FINAL (si un webhook ya marcó fallo de entrega definitivo, la aceptación HTTP no lo borra).
   */
  static readonly ALLOWED_FOR_WORKER_PROCESSED: InboundMessageStatus[] = ['SENDING', 'UNCERTAIN'];

  /**
   * Estados desde los cuales el worker puede transicionar el mensaje a UNCERTAIN ante timeout o fallo de socket.
   * SOLO permite SENDING. Si un webhook concurrente ya marcó PROCESSED, la actualización no surtirá efecto.
   */
  static readonly ALLOWED_FOR_WORKER_UNCERTAIN: InboundMessageStatus[] = ['SENDING'];

  /**
   * Estados desde los cuales el worker puede transicionar el mensaje a RETRY_PENDING ante error transitorio de Meta.
   */
  static readonly ALLOWED_FOR_WORKER_RETRY: InboundMessageStatus[] = ['SENDING'];

  /**
   * Estados desde los cuales el worker puede transicionar el mensaje a FAILED_FINAL ante rechazo fatal o intentos agotados.
   * NUNCA incluye PROCESSED.
   */
  static readonly ALLOWED_FOR_WORKER_FAILED: InboundMessageStatus[] = ['SENDING', 'UNCERTAIN'];

  /**
   * Estados desde los cuales el reconciliador de webhooks puede actualizar el mensaje ante sent, delivered o read.
   * Incluye PROCESSED para limpiar sistemáticamente deliveryUncertain y garantizar coherencia de outboundMessageId.
   */
  static readonly ALLOWED_FOR_WEBHOOK_PROCESSED: InboundMessageStatus[] = [
    'SENDING',
    'UNCERTAIN',
    'CLAIMED',
    'PROCESSED',
  ];

  /**
   * Estados desde los cuales el reconciliador de webhooks puede transicionar el mensaje a FAILED_FINAL
   * (evento failed de Meta cuando el intento NO estaba confirmado como DELIVERED o READ).
   */
  static readonly ALLOWED_FOR_WEBHOOK_FAILED: InboundMessageStatus[] = [
    'SENDING',
    'UNCERTAIN',
    'CLAIMED',
    'PROCESSED', // Válido solo si el intento estaba únicamente en ACCEPTED (transporte) y nunca fue entregado
  ];

  /**
   * Estados permitidos para actualizar WhatsAppSendAttempt a ACCEPTED (transporte HTTP exitoso).
   * NUNCA incluye FATAL_FAILURE ni estados de entrega confirmada.
   */
  static readonly ALLOWED_ATTEMPT_FOR_ACCEPTED: WhatsAppSendAttemptStatus[] = [
    'INITIATED',
    'UNCERTAIN',
  ];

  /**
   * Estados permitidos para actualizar WhatsAppSendAttempt a UNCERTAIN tras timeout.
   */
  static readonly ALLOWED_ATTEMPT_FOR_UNCERTAIN: WhatsAppSendAttemptStatus[] = ['INITIATED'];

  /**
   * Estados permitidos para actualizar WhatsAppSendAttempt a SENT.
   * NUNCA incluye DELIVERED ni READ (inmutabilidad progresiva).
   */
  static readonly ALLOWED_ATTEMPT_FOR_SENT: string[] = ['INITIATED', 'UNCERTAIN', 'ACCEPTED'];

  /**
   * Estados permitidos para actualizar WhatsAppSendAttempt a DELIVERED.
   * NUNCA incluye READ (un mensaje ya leído no se degrada a delivered).
   */
  static readonly ALLOWED_ATTEMPT_FOR_DELIVERED: string[] = [
    'INITIATED',
    'UNCERTAIN',
    'ACCEPTED',
    'SENT',
  ];

  /**
   * Estados permitidos para actualizar WhatsAppSendAttempt a READ.
   * Permite avanzar desde cualquier estado previo de transporte o entrega.
   */
  static readonly ALLOWED_ATTEMPT_FOR_READ: string[] = [
    'INITIATED',
    'UNCERTAIN',
    'ACCEPTED',
    'SENT',
    'DELIVERED',
  ];

  /**
   * Retorna los estados previos permitidos para avanzar a un estado positivo de entrega.
   */
  static getAllowedAttemptStatesForPositiveStatus(targetStatus: string): string[] {
    switch (targetStatus) {
      case 'READ':
        return this.ALLOWED_ATTEMPT_FOR_READ;
      case 'DELIVERED':
        return this.ALLOWED_ATTEMPT_FOR_DELIVERED;
      case 'SENT':
        return this.ALLOWED_ATTEMPT_FOR_SENT;
      default:
        return ['INITIATED', 'UNCERTAIN'];
    }
  }

  /**
   * Valida si un intento puede avanzar hacia el estado objetivo sin degradación.
   */
  static canTransitionAttempt(
    currentStatus: string | null | undefined,
    targetStatus: string,
  ): boolean {
    if (!currentStatus) return true;
    const allowed = this.getAllowedAttemptStatesForPositiveStatus(targetStatus);
    return allowed.includes(currentStatus);
  }

  /**
   * Determina si el estado actual de un intento ya es igual o superior al estado objetivo en la jerarquía positiva.
   * Evita transiciones redundantes manteniendo la validez del estado alcanzado.
   */
  static isAttemptAtOrAboveStatus(
    currentStatus: string | null | undefined,
    targetStatus: string,
  ): boolean {
    if (!currentStatus) return false;
    const order: Record<string, number> = {
      INITIATED: 0,
      UNCERTAIN: 0,
      ACCEPTED: 1,
      SENT: 2,
      DELIVERED: 3,
      READ: 4,
    };
    const currentRank = order[currentStatus] ?? -1;
    const targetRank = order[targetStatus] ?? 999;
    return currentRank >= targetRank;
  }

  /**
   * Estados permitidos para actualizar WhatsAppSendAttempt a FATAL_FAILURE o RETRYABLE_REJECTION ante fallo de entrega.
   * NUNCA incluye DELIVERED ni READ (inmutabilidad de confirmación).
   */
  static readonly ALLOWED_ATTEMPT_FOR_FATAL: string[] = [
    'INITIATED',
    'UNCERTAIN',
    'ACCEPTED',
    'SENT',
  ];

  /**
   * Determina si un intento ya tiene entrega confirmada y por ende no debe ser degradado por eventos contradictorios.
   */
  static isDeliveryConfirmed(attemptStatus?: string | null): boolean {
    if (!attemptStatus) return false;
    return this.CONFIRMED_DELIVERY_ATTEMPT_STATES.includes(attemptStatus);
  }
}
