import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { AppLogger } from '../../common/logging/logger.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WhatsAppSenderAdapter } from './whatsapp-sender.adapter';
import { WhatsAppStateTransitionPolicy } from './whatsapp-state-transition';
import { WhatsAppStatusReconcilerService } from './whatsapp-status-reconciler.service';

/**
 * Worker asíncrono desacoplado para procesamiento de mensajes entrantes de WhatsApp (Sprint 2 - S2.09-B).
 *
 * Principios arquitectónicos (ADR-008):
 * - Persistencia durable en PostgreSQL (inbound_messages).
 * - Reclamo atómico con claimToken UUID exclusivo gobernado por record.maxAttempts.
 * - Separación estricta de caídas en CLAIMED (claimRecoveryCount) vs intentos de envío a Meta (attempts).
 * - Transición atómica verificada CLAIMED -> SENDING antes del despacho a Meta.
 * - Cero reenvíos a ciegas: estados inciertos requieren reconciliación.
 * - Coherencia total de deliveryUncertain (limpieza sistemática ante resolución exitosa o fatal).
 * - Actualizaciones condicionales anti-sobrescritura entre worker y webhooks.
 * - Exclusión permanente de estados terminales (FAILED_FINAL).
 */
@Injectable()
export class WhatsAppQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private pollIntervalRef: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly defaultPollIntervalMs = 5000;
  private readonly leaseTimeoutMs = 60000; // 60 segundos de vigencia del lease
  private readonly defaultMaxAttempts = 3; // Límite por defecto de intentos de despacho
  private readonly maxClaimRecoveries = 3; // Límite de caídas en CLAIMED antes de marcar FAILED_FINAL
  private readonly batchSize = 25; // Tamaño de lote para procesamiento continuo (S2.09-A)
  static readonly MIN_MAX_ATTEMPTS = 1;
  static readonly MAX_MAX_ATTEMPTS = 10;

  /**
   * Valida estrictamente el rango admitido para maxAttempts (1 a 10).
   * No convierte silenciosamente valores inválidos (0, negativos, excesivos) en otro límite.
   */
  static validateMaxAttempts(value: number | null | undefined): {
    valid: boolean;
    value: number;
    error?: string;
  } {
    if (value === null || value === undefined) {
      return { valid: true, value: 3 }; // Valor por defecto del esquema Prisma
    }
    if (
      !Number.isInteger(value) ||
      value < this.MIN_MAX_ATTEMPTS ||
      value > this.MAX_MAX_ATTEMPTS
    ) {
      return {
        valid: false,
        value,
        error: `Valor de maxAttempts inválido (${value}). Rango estrictamente admitido: ${this.MIN_MAX_ATTEMPTS} a ${this.MAX_MAX_ATTEMPTS}.`,
      };
    }
    return { valid: true, value };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly senderAdapter: WhatsAppSenderAdapter,
    private readonly statusReconciler: WhatsAppStatusReconcilerService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit() {
    this.startWorker();
  }

  onModuleDestroy() {
    this.stopWorker();
  }

  startWorker() {
    if (this.pollIntervalRef) return;
    this.logger.log('Iniciando WhatsAppQueueProcessor worker...', 'WhatsAppQueueProcessor');
    this.pollIntervalRef = setInterval(() => {
      this.processPendingQueue().catch((err: unknown) => {
        const error = err as Error;
        this.logger.error(
          `Error en ciclo de WhatsAppQueueProcessor: ${error.message}`,
          error.stack,
          'WhatsAppQueueProcessor',
        );
      });
    }, this.defaultPollIntervalMs);
  }

  stopWorker() {
    if (this.pollIntervalRef) {
      clearInterval(this.pollIntervalRef);
      this.pollIntervalRef = null;
      this.logger.log('WhatsAppQueueProcessor worker detenido.', 'WhatsAppQueueProcessor');
    }
  }

  /**
   * Activación reactiva del worker sin bloquear la respuesta del webhook (S2.08).
   * Despacha el procesamiento asíncrono en el siguiente tick del event loop.
   */
  trigger(): void {
    setImmediate(() => {
      this.processPendingQueue().catch((err: unknown) => {
        const error = err as Error;
        this.logger.error(
          `Error en trigger reactivo de WhatsAppQueueProcessor: ${error.message}`,
          error.stack,
          'WhatsAppQueueProcessor',
        );
      });
    });
  }

  /**
   * Reclamo atómico del mensaje en PostgreSQL.
   * Utiliza claimToken UUID único y timestamp de inicio de procesamiento.
   * Respeta rigurosamente el límite record.maxAttempts individual de cada mensaje.
   * NOTA: NO incrementa el contador de envíos (attempts); attempts se incrementa
   * estrictamente al transicionar atómicamente a SENDING para evitar agotar intentos en caídas de lease.
   */
  async claimRecord(recordId: string): Promise<{ claimed: boolean; claimToken?: string }> {
    const record = await this.prisma.inboundMessage.findUnique({
      where: { id: recordId },
      select: { id: true, attempts: true, maxAttempts: true },
    });

    if (!record) {
      return { claimed: false };
    }

    const validation = WhatsAppQueueProcessor.validateMaxAttempts(record.maxAttempts);
    if (!validation.valid) {
      this.logger.error(
        `Registro [${recordId}] tiene maxAttempts inválido (${record.maxAttempts}). Marcando FAILED_FINAL sin conversión silenciosa.`,
        undefined,
        'WhatsAppQueueProcessor',
      );
      await this.prisma.inboundMessage.updateMany({
        where: { id: recordId, status: { in: ['RECEIVED', 'RETRY_PENDING'] } },
        data: {
          status: 'FAILED_FINAL',
          deliveryUncertain: false,
          errorMessage: validation.error,
          processedAt: new Date(),
        },
      });
      return { claimed: false };
    }

    const maxAllowed = validation.value;
    if (record.attempts >= maxAllowed) {
      await this.prisma.inboundMessage.updateMany({
        where: {
          id: recordId,
          status: { in: ['RECEIVED', 'RETRY_PENDING'] },
          attempts: { gte: maxAllowed },
        },
        data: {
          status: 'FAILED_FINAL',
          deliveryUncertain: false,
          errorMessage: `Intentos máximos agotados (${record.attempts}/${maxAllowed}) previo a reclamo.`,
          processedAt: new Date(),
        },
      });
      return { claimed: false };
    }

    const now = new Date();
    const claimToken = crypto.randomUUID();

    const claimResult = await this.prisma.inboundMessage.updateMany({
      where: {
        id: recordId,
        attempts: { lt: maxAllowed },
        OR: [
          { status: 'RECEIVED' },
          {
            status: 'RETRY_PENDING',
            nextRetryAt: { lte: now, not: null },
          },
        ],
      },
      data: {
        status: 'CLAIMED',
        claimToken,
        processingStartedAt: now,
      },
    });

    if (claimResult.count === 1) {
      return { claimed: true, claimToken };
    }

    return { claimed: false };
  }

  /**
   * Procesa un registro individual con separación estricta:
   * 1. Reclamo (CLAIMED) gobernado por record.maxAttempts.
   * 2. Transición atómica CLAIMED -> SENDING + incremento de attempts + creación de WhatsAppSendAttempt.
   * 3. Llamada externa a Meta con biz_opaque_callback_data = attemptId.
   * 4. Registro condicional del resultado y limpieza sistemática de deliveryUncertain.
   */
  async processRecord(recordId: string): Promise<boolean> {
    const { claimed, claimToken } = await this.claimRecord(recordId);
    if (!claimed || !claimToken) {
      return false;
    }

    const record = await this.prisma.inboundMessage.findUnique({
      where: { id: recordId },
    });

    if (!record) {
      return false;
    }

    // Consultar el historial del último intento para evaluar si ya existe entrega confirmada
    const lastAttempt = await this.prisma.whatsAppSendAttempt.findFirst({
      where: { inboundMessageId: record.id },
      orderBy: { attemptNumber: 'desc' },
    });

    const isConfirmedDelivered =
      lastAttempt && WhatsAppStateTransitionPolicy.isDeliveryConfirmed(lastAttempt.status);

    // Si ya fue confirmado físicamente como entregado o leído, o si responseSent es true y no está pendiente de reintento:
    if (isConfirmedDelivered || (record.responseSent && record.status !== 'RETRY_PENDING')) {
      this.logger.warn(
        `Mensaje [${record.externalMessageId}] ya fue enviado previamente. Evitando duplicación saliente.`,
        'WhatsAppQueueProcessor',
      );
      await this.prisma.inboundMessage.updateMany({
        where: { id: record.id, claimToken },
        data: {
          status: 'PROCESSED',
          deliveryUncertain: false,
        },
      });
      return true;
    }

    // 2. Transición atómica de CLAIMED a SENDING y creación del intento
    const leaseExpiration = new Date(Date.now() - this.leaseTimeoutMs);
    const validation = WhatsAppQueueProcessor.validateMaxAttempts(record.maxAttempts);
    if (!validation.valid) {
      await this.prisma.inboundMessage.updateMany({
        where: { id: record.id, claimToken, status: 'CLAIMED' },
        data: {
          status: 'FAILED_FINAL',
          errorMessage: validation.error,
          deliveryUncertain: false,
          nextRetryAt: null,
          processedAt: new Date(),
        },
      });
      return false;
    }
    const maxAllowed = validation.value;
    const attemptNumber = record.attempts + 1;

    // Si ya excedió el límite configurado de intentos de envío, marcar FAILED_FINAL
    if (attemptNumber > maxAllowed) {
      await this.prisma.inboundMessage.updateMany({
        where: { id: record.id, claimToken, status: 'CLAIMED' },
        data: {
          status: 'FAILED_FINAL',
          errorMessage: `Intentos máximos de envío (${maxAllowed}) agotados.`,
          deliveryUncertain: false,
          nextRetryAt: null,
          processedAt: new Date(),
        },
      });
      return false;
    }

    let attemptId = '';

    try {
      const txResult = await this.prisma.$transaction(async (tx) => {
        // Verificar que siga en CLAIMED, con el mismo claimToken y dentro de la vigencia del lease
        const updateResult = await tx.inboundMessage.updateMany({
          where: {
            id: record.id,
            status: 'CLAIMED',
            claimToken,
            processingStartedAt: { gte: leaseExpiration },
          },
          data: {
            status: 'SENDING',
            attempts: { increment: 1 }, // Incremento unívoco en el momento del despacho real
          },
        });

        if (updateResult.count !== 1) {
          return null;
        }

        const attempt = await tx.whatsAppSendAttempt.create({
          data: {
            inboundMessageId: record.id,
            attemptNumber,
            claimToken,
            status: 'INITIATED',
            initiatedAt: new Date(),
          },
        });

        return attempt.id;
      });

      if (!txResult) {
        this.logger.warn(
          `Reclamo perdido o expirado para [${record.externalMessageId}]. Abortando despacho hacia Meta.`,
          'WhatsAppQueueProcessor',
        );
        return false;
      }
      attemptId = txResult;
    } catch (err: unknown) {
      const error = err as Error;
      this.logger.error(
        `Fallo al registrar inicio de intento de envío para [${record.externalMessageId}]: ${error.message}`,
        error.stack,
        'WhatsAppQueueProcessor',
      );
      // Revertir a RECEIVED solo si el token y estado aún coinciden
      await this.prisma.inboundMessage.updateMany({
        where: { id: record.id, claimToken, status: 'CLAIMED' },
        data: { status: 'RECEIVED' },
      });
      return false;
    }

    let responseText = '';
    if (record.messageType === 'text') {
      responseText = `PelayoBot: Hemos recibido tu mensaje: "${record.content || ''}". Nuestro equipo o asistente continuará tu atención a la brevedad.`;
    } else if (record.messageType === 'interactive') {
      responseText = `PelayoBot: Opción seleccionada: "${record.content || ''}". Procesando tu requerimiento...`;
    } else {
      responseText = `PelayoBot: Por el momento solo puedo procesar mensajes de texto. Por favor indícanos tu consulta por escrito.`;
    }

    // 3. Llamada externa a Meta fuera de transacción con biz_opaque_callback_data = attemptId
    const sendResult = await this.senderAdapter.sendTextMessage(
      record.fromPhone,
      responseText,
      attemptId,
    );

    // 4. Actualización condicional del resultado (Anti-sobrescritura y coherencia de deliveryUncertain)
    if (sendResult.success && sendResult.messageId) {
      try {
        const [_attemptUpdate, msgUpdate] = await this.prisma.$transaction([
          this.prisma.whatsAppSendAttempt.updateMany({
            where: {
              id: attemptId,
              claimToken,
              status: { in: WhatsAppStateTransitionPolicy.ALLOWED_ATTEMPT_FOR_ACCEPTED },
            },
            data: {
              status: 'ACCEPTED',
              outboundMessageId: sendResult.messageId,
              responsePayload: responseText,
              completedAt: new Date(),
            },
          }),
          // Actualización condicional: Limpia sistemáticamente deliveryUncertain: false
          this.prisma.inboundMessage.updateMany({
            where: {
              id: record.id,
              claimToken,
              status: { in: WhatsAppStateTransitionPolicy.ALLOWED_FOR_WORKER_PROCESSED },
            },
            data: {
              status: 'PROCESSED',
              responseSent: true,
              outboundMessageId: sendResult.messageId,
              deliveryUncertain: false,
              responsePayload: responseText,
              errorMessage: null,
              processedAt: new Date(),
            },
          }),
        ]);

        if (msgUpdate.count === 0) {
          this.logger.log(
            `Worker post-envío: Mensaje [${record.externalMessageId}] no fue actualizado a PROCESSED porque su estado actual ya avanzó o fue resuelto por webhook.`,
            'WhatsAppQueueProcessor',
          );
        }

        return true;
      } catch (dbErr: unknown) {
        const error = dbErr as Error;
        this.logger.error(
          `Envío aceptado por Meta (wamid=${sendResult.messageId}) pero falló actualización en DB para [${record.externalMessageId}]: ${error.message}. Intento protegido contra reenvío ciego.`,
          error.stack,
          'WhatsAppQueueProcessor',
        );
        return true;
      }
    }

    // Tratamiento de resultados inciertos: Timeout, respuesta inválida o error de socket/red
    if (
      sendResult.errorType === 'UNCERTAIN_TIMEOUT' ||
      sendResult.errorType === 'INVALID_RESPONSE' ||
      sendResult.errorType === 'NETWORK_ERROR'
    ) {
      this.logger.warn(
        `Envío incierto (${sendResult.errorType}) para [${record.externalMessageId}]: ${sendResult.error}. Marcado como UNCERTAIN sin reintento ciego.`,
        'WhatsAppQueueProcessor',
      );

      const [_attemptUpdate, msgUpdate] = await this.prisma.$transaction([
        this.prisma.whatsAppSendAttempt.updateMany({
          where: {
            id: attemptId,
            claimToken,
            status: { in: WhatsAppStateTransitionPolicy.ALLOWED_ATTEMPT_FOR_UNCERTAIN },
          },
          data: {
            status: 'UNCERTAIN',
            errorMessage: sendResult.error,
            completedAt: new Date(),
          },
        }),
        // Actualización condicional crítica: SOLO si todavía está en SENDING.
        // Si un webhook entregado (delivered) llegó antes y marcó PROCESSED, NO se degrada a UNCERTAIN.
        this.prisma.inboundMessage.updateMany({
          where: {
            id: record.id,
            claimToken,
            status: { in: WhatsAppStateTransitionPolicy.ALLOWED_FOR_WORKER_UNCERTAIN },
          },
          data: {
            status: 'UNCERTAIN',
            deliveryUncertain: true,
            errorMessage: sendResult.error,
            processedAt: new Date(),
          },
        }),
      ]);

      if (msgUpdate.count === 0) {
        this.logger.log(
          `Worker timeout/incertidumbre: Mensaje [${record.externalMessageId}] no fue degradado a UNCERTAIN porque su estado ya fue confirmado por webhook concurrente.`,
          'WhatsAppQueueProcessor',
        );
      }

      return false;
    }

    // Rechazo reintentable vs Fallo definitivo
    const isExhausted = attemptNumber >= maxAllowed;
    const isRetryable = sendResult.errorType === 'EXPLICIT_RETRYABLE' && !isExhausted;

    if (isRetryable) {
      const nextRetryAt = this.calculateNextRetry(attemptNumber);
      await this.prisma.$transaction([
        this.prisma.whatsAppSendAttempt.updateMany({
          where: {
            id: attemptId,
            claimToken,
            status: { in: ['INITIATED'] },
          },
          data: {
            status: 'RETRYABLE_REJECTION',
            errorMessage: sendResult.error,
            completedAt: new Date(),
          },
        }),
        // Solo actualizar a RETRY_PENDING si el registro sigue en SENDING
        this.prisma.inboundMessage.updateMany({
          where: {
            id: record.id,
            claimToken,
            status: { in: WhatsAppStateTransitionPolicy.ALLOWED_FOR_WORKER_RETRY },
          },
          data: {
            status: 'RETRY_PENDING',
            responseSent: false,
            deliveryUncertain: false,
            errorMessage: sendResult.error,
            nextRetryAt,
            processedAt: new Date(),
          },
        }),
      ]);

      this.logger.warn(
        `Mensaje [${record.externalMessageId}] falló transitoriamente (intento ${attemptNumber}/${maxAllowed}). Próximo reintento programado: ${nextRetryAt.toISOString()}.`,
        'WhatsAppQueueProcessor',
      );
    } else {
      // Fallo definitivo: EXPLICIT_FATAL (131030, 131031, etc.), CONFIG_ERROR o intentos agotados
      await this.prisma.$transaction([
        this.prisma.whatsAppSendAttempt.updateMany({
          where: {
            id: attemptId,
            claimToken,
            status: { in: ['INITIATED', 'UNCERTAIN'] },
          },
          data: {
            status: 'FATAL_FAILURE',
            errorMessage: sendResult.error,
            completedAt: new Date(),
          },
        }),
        this.prisma.inboundMessage.updateMany({
          where: {
            id: record.id,
            claimToken,
            status: { in: WhatsAppStateTransitionPolicy.ALLOWED_FOR_WORKER_FAILED },
          },
          data: {
            status: 'FAILED_FINAL',
            responseSent: false,
            deliveryUncertain: false,
            errorMessage: sendResult.error,
            nextRetryAt: null,
            processedAt: new Date(),
          },
        }),
      ]);

      this.logger.error(
        `Mensaje [${record.externalMessageId}] falló definitivamente (${sendResult.errorType}, intentos: ${attemptNumber}): ${sendResult.error}. Excluido de la cola.`,
        undefined,
        'WhatsAppQueueProcessor',
      );
    }

    return false;
  }

  /**
   * Recupera leases expirados de forma diferenciada:
   * 1. Registros en CLAIMED (caídas antes de llamar a Meta):
   *    - Si claimRecoveryCount >= 3: transiciona explícitamente a FAILED_FINAL para auditoría.
   *    - Si claimRecoveryCount < 3: incrementa claimRecoveryCount y vuelve a RECEIVED sin consumir attempts de envío.
   * 2. Registros en SENDING (caídas durante o posterior al despacho):
   *    - Transiciona condicionalmente a UNCERTAIN (deliveryUncertain = true); cero reenvíos a ciegas.
   */
  async recoverExpiredLeases(): Promise<number> {
    const leaseExpiration = new Date(Date.now() - this.leaseTimeoutMs);

    // 1. Mensajes que quedaron en CLAIMED y vencieron
    const expiredClaimed = await this.prisma.inboundMessage.findMany({
      where: {
        status: 'CLAIMED',
        processingStartedAt: { lt: leaseExpiration },
      },
      select: {
        id: true,
        externalMessageId: true,
        claimRecoveryCount: true,
        processingStartedAt: true,
      },
    });

    let reclaimedClaimedCount = 0;
    for (const item of expiredClaimed) {
      const recoveries = (item.claimRecoveryCount || 0) + 1;
      if (recoveries >= this.maxClaimRecoveries) {
        // Excedió el límite de caídas de worker en CLAIMED sin llegar a SENDING
        await this.prisma.inboundMessage.updateMany({
          where: {
            id: item.id,
            status: 'CLAIMED',
            processingStartedAt: item.processingStartedAt,
          },
          data: {
            status: 'FAILED_FINAL',
            claimToken: null,
            claimRecoveryCount: recoveries,
            deliveryUncertain: false,
            errorMessage: `Límite de recuperaciones de reclamo sin despacho a Meta (${this.maxClaimRecoveries}) alcanzado. Requiere revisión.`,
            processedAt: new Date(),
          },
        });
        this.logger.error(
          `Alerta de resiliencia: Mensaje [${item.externalMessageId}] cayó ${recoveries} veces en CLAIMED sin alcanzar SENDING. Transicionado a FAILED_FINAL.`,
          undefined,
          'WhatsAppQueueProcessor',
        );
        reclaimedClaimedCount++;
      } else {
        const res = await this.prisma.inboundMessage.updateMany({
          where: {
            id: item.id,
            status: 'CLAIMED',
            processingStartedAt: item.processingStartedAt,
          },
          data: {
            status: 'RECEIVED',
            claimToken: null,
            claimRecoveryCount: recoveries,
          },
        });
        if (res.count === 1) {
          reclaimedClaimedCount++;
        }
      }
    }

    // 2. Mensajes que quedaron en SENDING y vencieron
    const uncertainRecords = await this.prisma.inboundMessage.findMany({
      where: {
        status: 'SENDING',
        processingStartedAt: { lt: leaseExpiration },
      },
      select: { id: true, externalMessageId: true, processingStartedAt: true },
    });

    let uncertainCount = 0;
    for (const item of uncertainRecords) {
      // Actualización atómica condicional: solo actualizar si todavía está en SENDING y vencido
      const updated = await this.prisma.$transaction(async (tx) => {
        const msgUpdate = await tx.inboundMessage.updateMany({
          where: {
            id: item.id,
            status: 'SENDING',
            processingStartedAt: item.processingStartedAt,
          },
          data: {
            status: 'UNCERTAIN',
            deliveryUncertain: true,
            errorMessage: 'Lease vencido en estado SENDING sin confirmación de resultado.',
          },
        });

        if (msgUpdate.count === 1) {
          await tx.whatsAppSendAttempt.updateMany({
            where: {
              inboundMessageId: item.id,
              status: 'INITIATED',
            },
            data: {
              status: 'UNCERTAIN',
              errorMessage: 'Worker interrumpido durante o posterior al envío.',
              completedAt: new Date(),
            },
          });
          return true;
        }
        return false;
      });

      if (updated) {
        uncertainCount++;
        this.logger.warn(
          `Alerta de resiliencia: Mensaje [${item.externalMessageId}] expiró lease en estado SENDING. Transicionando a UNCERTAIN para reconciliación; no se reenvía automáticamente.`,
          'WhatsAppQueueProcessor',
        );
      }
    }

    return reclaimedClaimedCount + uncertainCount;
  }

  /**
   * Procesa lotes continuos de mensajes pendientes hasta vaciar la cola elegible.
   * Respeta estrictamente el tamaño de lote (batchSize = 25).
   * Selecciona RECEIVED o RETRY_PENDING con nextRetryAt cumplido, sin hardcodear límites estáticos
   * para permitir que cada mensaje sea evaluado según su propio record.maxAttempts.
   * Barre además eventos de estado pendientes de reconciliación.
   */
  async processPendingQueue(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    let totalProcessed = 0;

    try {
      await this.recoverExpiredLeases();

      // Reconciliar eventos de estado pendientes con programación y backoff
      try {
        await this.statusReconciler.reconcilePendingEvents();
      } catch (reconcileErr: unknown) {
        const err = reconcileErr as Error;
        this.logger.warn(
          `Advertencia al reconciliar eventos pendientes: ${err.message}`,
          'WhatsAppQueueProcessor',
        );
      }

      let hasMore = true;
      const maxBatches = 20; // Límite defensivo de trabajo por ciclo (S2.09-A / S2.10-A)
      let currentBatch = 0;

      while (hasMore && currentBatch < maxBatches) {
        currentBatch++;
        const now = new Date();

        const batch = await this.prisma.inboundMessage.findMany({
          where: {
            OR: [
              { status: 'RECEIVED' },
              {
                status: 'RETRY_PENDING',
                nextRetryAt: { lte: now, not: null },
              },
            ],
          },
          take: this.batchSize,
          orderBy: { receivedAt: 'asc' },
        });

        if (batch.length === 0) {
          hasMore = false;
          break;
        }

        let processedInBatch = 0;
        let resolvedExhaustedInBatch = 0;

        for (const item of batch) {
          const validation = WhatsAppQueueProcessor.validateMaxAttempts(item.maxAttempts);
          if (!validation.valid) {
            await this.prisma.inboundMessage.updateMany({
              where: {
                id: item.id,
                status: { in: ['RECEIVED', 'RETRY_PENDING'] },
              },
              data: {
                status: 'FAILED_FINAL',
                deliveryUncertain: false,
                errorMessage: validation.error,
                processedAt: new Date(),
              },
            });
            resolvedExhaustedInBatch++;
            continue;
          }

          const maxAllowed = validation.value;
          // Si el registro ya está agotado individualmente, resolverlo de inmediato a FAILED_FINAL
          if (item.attempts >= maxAllowed) {
            await this.prisma.inboundMessage.updateMany({
              where: {
                id: item.id,
                status: { in: ['RECEIVED', 'RETRY_PENDING'] },
                attempts: { gte: maxAllowed },
              },
              data: {
                status: 'FAILED_FINAL',
                deliveryUncertain: false,
                errorMessage: `Intentos máximos agotados (${item.attempts}/${maxAllowed}) previo a reclamo.`,
                processedAt: new Date(),
              },
            });
            resolvedExhaustedInBatch++;
            continue;
          }

          const ok = await this.processRecord(item.id);
          if (ok) {
            totalProcessed++;
            processedInBatch++;
          }
        }

        // Salida defensiva: Si ningún mensaje del lote pudo ser procesado ni resuelto, romper el ciclo para evitar bucle infinito
        if (processedInBatch === 0 && resolvedExhaustedInBatch === 0) {
          this.logger.warn(
            'Lote de pendientes no produjo progreso; interrumpiendo ciclo para evitar bucle infinito.',
            'WhatsAppQueueProcessor',
          );
          hasMore = false;
          break;
        }

        if (batch.length < this.batchSize) {
          hasMore = false;
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return totalProcessed;
  }

  /**
   * Cálculo de backoff progresivo:
   * Con backoff progresivo según el número de intentos: 5s, 15s, 45s, 120s.
   */
  calculateNextRetry(attempts: number): Date {
    const delaysInSeconds = [5, 15, 45, 120];
    const delay = delaysInSeconds[Math.min(attempts - 1, delaysInSeconds.length - 1)] || 120;
    return new Date(Date.now() + delay * 1000);
  }
}
