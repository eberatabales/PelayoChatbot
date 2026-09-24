import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppLogger } from '../../common/logging/logger.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { classifyMetaError } from './whatsapp-error-classifier';
import { WhatsAppStateTransitionPolicy } from './whatsapp-state-transition';
import { WhatsAppRawStatus } from './whatsapp.types';

@Injectable()
export class WhatsAppStatusReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Procesa, persiste y reconcilia un evento de estado de Meta (S2.09-B).
   * Tolera eventos duplicados, reintentos y fuera de orden.
   * Correlaciona exclusivamente mediante identificadores exactos:
   * 1. biz_opaque_callback_data (attemptId)
   * 2. outboundMessageId (wamid de Meta)
   * NUNCA adivina por número de teléfono.
   * Aplica inmutabilidad sobre entregas confirmadas (DELIVERED/READ) y limpia deliveryUncertain.
   */
  async ingestAndReconcile(rawStatus: WhatsAppRawStatus): Promise<boolean> {
    const statusId = `${rawStatus.id}_${rawStatus.status}_${rawStatus.timestamp}`;
    const outboundMessageId = rawStatus.id;
    const recipientId = rawStatus.recipient_id;
    const status = rawStatus.status;
    const bizOpaqueCallbackData = rawStatus.biz_opaque_callback_data;

    // 1. Persistencia durable del evento de estado
    let event = await this.prisma.whatsAppStatusEvent.findUnique({
      where: { statusId },
    });

    if (event && event.reconciled) {
      this.logger.log(
        `Evento de estado ya reconciliado previamente: [${statusId}]`,
        'WhatsAppStatusReconcilerService',
      );
      return true;
    }

    if (!event) {
      try {
        event = await this.prisma.whatsAppStatusEvent.create({
          data: {
            statusId,
            externalMessageId: outboundMessageId,
            recipientId,
            status,
            timestamp: rawStatus.timestamp,
            rawPayload: rawStatus as unknown as Prisma.InputJsonValue,
            reconciled: false,
            nextReconcileAt: new Date(Date.now() + 5000), // Margen de 5s para que el worker guarde su outboundId
          },
        });
      } catch (err: unknown) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          event = await this.prisma.whatsAppStatusEvent.findUnique({
            where: { statusId },
          });
          if (event?.reconciled) return true;
        } else {
          const error = err as Error;
          this.logger.error(
            `Error al persistir whatsapp_status_events: ${error.message}`,
            error.stack,
            'WhatsAppStatusReconcilerService',
          );
          throw err;
        }
      }
    }

    // 2. Correlación estricta por identificadores inequívocos (Cero adivinanzas por teléfono)
    let matchingAttempt = null;

    // 2.1 Primero por biz_opaque_callback_data (attemptId) si existe
    if (bizOpaqueCallbackData) {
      matchingAttempt = await this.prisma.whatsAppSendAttempt.findUnique({
        where: { id: bizOpaqueCallbackData },
        include: { inboundMessage: true },
      });
    }

    // 2.2 Si no coincide o no viene, buscar por outboundMessageId exacto en los intentos
    if (!matchingAttempt && outboundMessageId) {
      matchingAttempt = await this.prisma.whatsAppSendAttempt.findFirst({
        where: { outboundMessageId },
        include: { inboundMessage: true },
      });
    }

    // 2.3 Si el intento aún no tenía outboundMessageId guardado, verificar en el mensaje
    let message = matchingAttempt?.inboundMessage;
    if (!matchingAttempt && outboundMessageId) {
      const candidateMsg = await this.prisma.inboundMessage.findFirst({
        where: { outboundMessageId },
        include: {
          sendAttempts: {
            orderBy: { initiatedAt: 'desc' },
            take: 1,
          },
        },
      });
      if (candidateMsg) {
        message = candidateMsg;
        matchingAttempt = candidateMsg.sendAttempts[0] || null;
      }
    }

    // Si no se encuentra correlación unívoca, el evento permanece con reconciled = false
    if (!matchingAttempt || !message) {
      this.logger.log(
        `Evento de estado [${status}] para wamid=${outboundMessageId} sin coincidencia unívoca (callback=${bizOpaqueCallbackData || 'none'}). Almacenado como no reconciliado.`,
        'WhatsAppStatusReconcilerService',
      );
      return false;
    }

    // 3. Resolución según el estado reportado por Meta
    if (status === 'sent' || status === 'delivered' || status === 'read') {
      const attemptTargetStatus =
        status === 'read' ? 'READ' : status === 'delivered' ? 'DELIVERED' : 'SENT';

      this.logger.log(
        `Reconciliación exitosa: Mensaje [${message.externalMessageId}] confirmado como ${status} (wamid=${outboundMessageId}). Transicionando intento a ${attemptTargetStatus}.`,
        'WhatsAppStatusReconcilerService',
      );

      return await this.prisma.$transaction(async (tx) => {
        // 1. Obtener estado fresco del intento dentro de la transacción
        const freshAttempt = await tx.whatsAppSendAttempt.findUnique({
          where: { id: matchingAttempt.id },
        });
        const currentAttempt = freshAttempt || matchingAttempt;

        // 2. Comprobar si el evento corresponde a un intento histórico ya superado por otro intento posterior
        const latestAttempt = await tx.whatsAppSendAttempt.findFirst({
          where: { inboundMessageId: currentAttempt.inboundMessageId },
          orderBy: { attemptNumber: 'desc' },
        });

        const isHistoricalAttempt = Boolean(
          latestAttempt && latestAttempt.attemptNumber > currentAttempt.attemptNumber,
        );

        if (isHistoricalAttempt) {
          this.logger.warn(
            `Evento positivo [${status}] de intento histórico (#${currentAttempt.attemptNumber}) recibido para [${message.externalMessageId}]. Ya existe intento más reciente (#${latestAttempt?.attemptNumber}). No se altera el mensaje.`,
            'WhatsAppStatusReconcilerService',
          );

          if (
            WhatsAppStateTransitionPolicy.canTransitionAttempt(
              currentAttempt.status,
              attemptTargetStatus,
            )
          ) {
            await tx.whatsAppSendAttempt.updateMany({
              where: {
                id: currentAttempt.id,
                status: {
                  in: WhatsAppStateTransitionPolicy.getAllowedAttemptStatesForPositiveStatus(
                    attemptTargetStatus,
                  ),
                },
              },
              data: {
                status: attemptTargetStatus,
                outboundMessageId,
                completedAt: new Date(),
              },
            });
          }

          await tx.whatsAppStatusEvent.updateMany({
            where: { statusId },
            data: {
              reconciled: true,
              abandoned: false,
              lastError: `Evento positivo de intento histórico (#${currentAttempt.attemptNumber}) descartado para el mensaje porque existe un intento posterior (#${latestAttempt?.attemptNumber}).`,
            },
          });

          return true;
        }

        // 3. Intento vigente: distinguir entre transición permitida, evento repetido/superior o transición rechazada
        const isAlreadyAtOrAbove = WhatsAppStateTransitionPolicy.isAttemptAtOrAboveStatus(
          currentAttempt.status,
          attemptTargetStatus,
        );

        const canTransition = WhatsAppStateTransitionPolicy.canTransitionAttempt(
          currentAttempt.status,
          attemptTargetStatus,
        );

        if (!isAlreadyAtOrAbove && !canTransition) {
          // Transición rechazada (ej: intento en RETRYABLE_REJECTION o FATAL_FAILURE, llega un sent atrasado)
          this.logger.warn(
            `Transición positiva ${attemptTargetStatus} rechazada para intento [${currentAttempt.id}] en estado [${currentAttempt.status}]. No se altera el mensaje.`,
            'WhatsAppStatusReconcilerService',
          );

          await tx.whatsAppStatusEvent.updateMany({
            where: { statusId },
            data: {
              reconciled: true,
              abandoned: false,
              lastError: `Transición positiva ${attemptTargetStatus} rechazada porque el intento está en estado incompatible (${currentAttempt.status}).`,
            },
          });

          return true;
        }

        // Si corresponde avanzar el intento, realizar la actualización atómica
        if (canTransition) {
          const attemptUpdate = await tx.whatsAppSendAttempt.updateMany({
            where: {
              id: currentAttempt.id,
              status: {
                in: WhatsAppStateTransitionPolicy.getAllowedAttemptStatesForPositiveStatus(
                  attemptTargetStatus,
                ),
              },
            },
            data: {
              status: attemptTargetStatus,
              outboundMessageId,
              completedAt: new Date(),
            },
          });

          if (attemptUpdate.count === 0) {
            const recheck = await tx.whatsAppSendAttempt.findUnique({
              where: { id: currentAttempt.id },
            });
            if (
              !recheck ||
              !WhatsAppStateTransitionPolicy.isAttemptAtOrAboveStatus(
                recheck.status,
                attemptTargetStatus,
              )
            ) {
              this.logger.warn(
                `Alerta de concurrencia: Intento [${currentAttempt.id}] no pudo transicionar a ${attemptTargetStatus} (count === 0). No se altera el mensaje.`,
                'WhatsAppStatusReconcilerService',
              );
              await tx.whatsAppStatusEvent.updateMany({
                where: { statusId },
                data: {
                  reconciled: true,
                  abandoned: false,
                  lastError: `Transición de intento no efectuada por colisión de concurrencia.`,
                },
              });
              return true;
            }
          }
        } else {
          this.logger.log(
            `Intento [${matchingAttempt.id}] ya se encontraba en estado igual o superior (${currentAttempt.status}). Conservando estado sin degradar a ${attemptTargetStatus}.`,
            'WhatsAppStatusReconcilerService',
          );
        }

        // 4. Actualizar el mensaje a PROCESSED únicamente vinculado atómicamente al intento vigente (igualdad exacta)
        const msgUpdate = await tx.inboundMessage.updateMany({
          where: {
            id: message.id,
            attempts: currentAttempt.attemptNumber, // VINCULACIÓN ATÓMICA EXACTA: solo el intento vigente puede actualizar
            status: {
              in: WhatsAppStateTransitionPolicy.ALLOWED_FOR_WEBHOOK_PROCESSED,
            },
          },
          data: {
            status: 'PROCESSED',
            responseSent: true,
            outboundMessageId,
            deliveryUncertain: false,
            processedAt: new Date(),
          },
        });

        let reconcileNote: string | null = null;
        if (msgUpdate.count === 0) {
          const freshMsg = await tx.inboundMessage.findUnique({
            where: { id: message.id },
          });
          const reason =
            freshMsg && freshMsg.attempts > currentAttempt.attemptNumber
              ? `Avance concurrente a intento posterior (#${freshMsg.attempts} > #${currentAttempt.attemptNumber})`
              : freshMsg?.status === 'PROCESSED'
                ? 'Mensaje ya procesado previamente'
                : `Estado o versión incompatible (${freshMsg?.status}, intento #${freshMsg?.attempts})`;

          this.logger.warn(
            `Alerta de concurrencia: InboundMessage [${message.id}] no fue actualizado a PROCESSED: ${reason}.`,
            'WhatsAppStatusReconcilerService',
          );
          reconcileNote = `Evento positivo para intento #${currentAttempt.attemptNumber} no alteró mensaje: ${reason}.`;
        }

        // 5. Marcar evento como reconciliado dentro de la misma transacción
        await tx.whatsAppStatusEvent.updateMany({
          where: { statusId },
          data: {
            reconciled: true,
            abandoned: false,
            lastError: reconcileNote,
          },
        });

        return true;
      });
    } else if (status === 'failed') {
      // Clasificación unificada del error de entrega
      const errItem = rawStatus.errors?.[0];
      const classified = classifyMetaError({
        metaCode: errItem?.code,
        rawMessage: errItem?.title || errItem?.message,
      });
      const errorDetail = `Error Meta ${classified.code || 'desconocido'}: ${classified.message}${classified.userFacingAction ? ` [Acción: ${classified.userFacingAction}]` : ''}`;

      return await this.prisma.$transaction(async (tx) => {
        // 1. Obtener estado fresco del intento dentro de la transacción
        const freshAttempt = await tx.whatsAppSendAttempt.findUnique({
          where: { id: matchingAttempt.id },
        });
        const currentAttempt = freshAttempt || matchingAttempt;

        // 2. Inmutabilidad de la entrega confirmada: si ya está en DELIVERED o READ, rechazar degradación
        if (WhatsAppStateTransitionPolicy.isDeliveryConfirmed(currentAttempt.status)) {
          this.logger.warn(
            `Alerta de concurrencia: Webhook 'failed' recibido para [${message.externalMessageId}], pero el intento ya estaba confirmado como ${currentAttempt.status}. Rechazando degradación contradictoria.`,
            'WhatsAppStatusReconcilerService',
          );

          await tx.whatsAppStatusEvent.updateMany({
            where: { statusId },
            data: {
              reconciled: true,
              abandoned: false,
              lastError: `Evento contradictorio descartado: el intento ya estaba confirmado físicamente como ${currentAttempt.status}.`,
            },
          });

          return true;
        }

        // 3. Protección ante fallos de intentos históricos superados por reintentos posteriores
        const latestAttempt = await tx.whatsAppSendAttempt.findFirst({
          where: { inboundMessageId: currentAttempt.inboundMessageId },
          orderBy: { attemptNumber: 'desc' },
        });

        if (latestAttempt && latestAttempt.attemptNumber > currentAttempt.attemptNumber) {
          this.logger.warn(
            `Fallo de intento histórico (#${currentAttempt.attemptNumber}) recibido para [${message.externalMessageId}]. Ya existe intento más reciente (#${latestAttempt.attemptNumber}). Actualizando solo intento histórico sin alterar mensaje.`,
            'WhatsAppStatusReconcilerService',
          );

          await tx.whatsAppSendAttempt.updateMany({
            where: {
              id: currentAttempt.id,
              status: { in: WhatsAppStateTransitionPolicy.ALLOWED_ATTEMPT_FOR_FATAL },
            },
            data: {
              status: classified.isRetryable ? 'RETRYABLE_REJECTION' : 'FATAL_FAILURE',
              errorMessage: errorDetail,
              completedAt: new Date(),
            },
          });

          await tx.whatsAppStatusEvent.updateMany({
            where: { statusId },
            data: {
              reconciled: true,
              abandoned: false,
              lastError: `Fallo de intento histórico (#${currentAttempt.attemptNumber}) descartado porque existe un intento posterior (#${latestAttempt.attemptNumber}).`,
            },
          });

          return true;
        }

        // 4. Intento vigente: actualizar el intento atómicamente condicionando por ALLOWED_ATTEMPT_FOR_FATAL
        const maxAllowed = message.maxAttempts || 3;
        const isRetryable = classified.isRetryable && message.attempts < maxAllowed;
        const attemptTargetStatus = isRetryable ? 'RETRYABLE_REJECTION' : 'FATAL_FAILURE';

        const attemptUpdate = await tx.whatsAppSendAttempt.updateMany({
          where: {
            id: currentAttempt.id,
            status: { in: WhatsAppStateTransitionPolicy.ALLOWED_ATTEMPT_FOR_FATAL },
          },
          data: {
            status: attemptTargetStatus,
            errorMessage: errorDetail,
            completedAt: new Date(),
          },
        });

        // Verificación de concurrencia: si attemptUpdate.count === 0, el intento ya fue confirmado
        // como DELIVERED o READ concurrentemente mientras esperábamos el lock en PostgreSQL.
        // En este caso, NO debemos modificar inboundMessage.
        if (attemptUpdate.count === 0) {
          this.logger.warn(
            `Alerta de concurrencia: Intento [${currentAttempt.id}] ya no es elegible para fallo (count === 0, confirmado concurrentemente). Rechazando modificar mensaje.`,
            'WhatsAppStatusReconcilerService',
          );
          await tx.whatsAppStatusEvent.updateMany({
            where: { statusId },
            data: {
              reconciled: true,
              abandoned: false,
              lastError:
                'Evento contradictorio descartado: el intento fue confirmado concurrentemente.',
            },
          });
          return true;
        }

        let reconcileErrorNote: string | null = null;

        if (isRetryable) {
          const delaysInSeconds = [5, 15, 45, 120];
          const delay =
            delaysInSeconds[Math.min(message.attempts - 1, delaysInSeconds.length - 1)] || 120;
          const nextRetryAt = new Date(Date.now() + delay * 1000);

          this.logger.warn(
            `Entrega fallida transitoria para [${message.externalMessageId}]: ${errorDetail}. Reintento programado para: ${nextRetryAt.toISOString()}`,
            'WhatsAppStatusReconcilerService',
          );

          // Actualizar mensaje a RETRY_PENDING, limpiando outboundMessageId para forzar reenvío en worker
          const updateRes = await tx.inboundMessage.updateMany({
            where: {
              id: message.id,
              attempts: currentAttempt.attemptNumber, // VINCULACIÓN ATÓMICA EXACTA: solo el intento vigente puede actualizar
              status: { in: WhatsAppStateTransitionPolicy.ALLOWED_FOR_WEBHOOK_FAILED },
            },
            data: {
              status: 'RETRY_PENDING',
              responseSent: false,
              deliveryUncertain: false,
              outboundMessageId: null, // Limpiado para permitir nuevo intento real en worker
              errorMessage: errorDetail,
              nextRetryAt,
              processedAt: new Date(),
            },
          });

          if (updateRes.count === 0) {
            const freshMsg = await tx.inboundMessage.findUnique({
              where: { id: message.id },
            });
            const reason =
              freshMsg && freshMsg.attempts > currentAttempt.attemptNumber
                ? `Avance concurrente a intento posterior (#${freshMsg.attempts} > #${currentAttempt.attemptNumber})`
                : `Estado o versión incompatible (${freshMsg?.status}, intento #${freshMsg?.attempts})`;

            this.logger.warn(
              `Alerta de concurrencia: InboundMessage [${message.id}] no fue actualizado a RETRY_PENDING: ${reason}.`,
              'WhatsAppStatusReconcilerService',
            );
            reconcileErrorNote = `Fallo para intento #${currentAttempt.attemptNumber} no alteró mensaje: ${reason}.`;
          }
        } else {
          // Fallo definitivo (fatal o intentos agotados)
          this.logger.warn(
            `Entrega fallida definitiva para [${message.externalMessageId}]: ${errorDetail}. Marcando FAILED_FINAL.`,
            'WhatsAppStatusReconcilerService',
          );

          const updateRes = await tx.inboundMessage.updateMany({
            where: {
              id: message.id,
              attempts: currentAttempt.attemptNumber, // VINCULACIÓN ATÓMICA EXACTA: solo el intento vigente puede actualizar
              status: { in: WhatsAppStateTransitionPolicy.ALLOWED_FOR_WEBHOOK_FAILED },
            },
            data: {
              status: 'FAILED_FINAL',
              responseSent: false,
              deliveryUncertain: false,
              errorMessage: errorDetail,
              nextRetryAt: null,
              processedAt: new Date(),
            },
          });

          if (updateRes.count === 0) {
            const freshMsg = await tx.inboundMessage.findUnique({
              where: { id: message.id },
            });
            const reason =
              freshMsg && freshMsg.attempts > currentAttempt.attemptNumber
                ? `Avance concurrente a intento posterior (#${freshMsg.attempts} > #${currentAttempt.attemptNumber})`
                : `Estado o versión incompatible (${freshMsg?.status}, intento #${freshMsg?.attempts})`;

            this.logger.warn(
              `Alerta de concurrencia: InboundMessage [${message.id}] no fue actualizado a FAILED_FINAL: ${reason}.`,
              'WhatsAppStatusReconcilerService',
            );
            reconcileErrorNote = `Fallo para intento #${currentAttempt.attemptNumber} no alteró mensaje: ${reason}.`;
          }
        }

        await tx.whatsAppStatusEvent.updateMany({
          where: { statusId },
          data: {
            reconciled: true,
            abandoned: false,
            lastError: reconcileErrorNote,
          },
        });

        return true;
      });
    }

    return false;
  }

  /**
   * Barre y reintenta reconciliar eventos de estado acumulados con reconciled = false (S2.09-B).
   * - Solo selecciona eventos no reconciliados y no abandonados cuyo nextReconcileAt <= now.
   * - Procesa continuamente en lotes para evitar que 50 eventos sin correspondencia bloqueen los siguientes.
   * - Aísla errores por evento con try/catch para evitar que una excepción interrumpa el resto del lote.
   * - Aplica backoff progresivo y marca como abandoned = true tras 5 intentos fallidos,
   *   eliminando por completo el bloqueo de cabeza de línea (Head-of-Line blocking) y derivando a revisión manual.
   */
  async reconcilePendingEvents(): Promise<number> {
    let reconciledCount = 0;
    let hasMore = true;
    const maxBatches = 10; // Límite defensivo de seguridad por barrido
    let currentBatch = 0;

    while (hasMore && currentBatch < maxBatches) {
      currentBatch++;
      const now = new Date();
      const pendingEvents = await this.prisma.whatsAppStatusEvent.findMany({
        where: {
          reconciled: false,
          abandoned: false,
          OR: [{ nextReconcileAt: { lte: now } }, { nextReconcileAt: null }],
        },
        take: 50,
        orderBy: [{ nextReconcileAt: 'asc' }, { receivedAt: 'asc' }],
      });

      if (pendingEvents.length === 0) {
        hasMore = false;
        break;
      }

      for (const evt of pendingEvents) {
        try {
          const rawPayload = evt.rawPayload as Record<string, unknown>;
          const rawStatus: WhatsAppRawStatus = {
            id: evt.externalMessageId,
            status: evt.status,
            timestamp: evt.timestamp,
            recipient_id: evt.recipientId,
            biz_opaque_callback_data: (rawPayload?.biz_opaque_callback_data as string) || undefined,
            ...rawPayload,
          };

          const ok = await this.ingestAndReconcile(rawStatus);
          if (ok) {
            reconciledCount++;
          } else {
            // Evento no encontró intento unívoco aún; programar siguiente reintento con backoff
            const attempts = (evt.reconcileAttempts || 0) + 1;
            const isAbandoned = attempts >= 5;
            const backoffSeconds = [10, 30, 60, 120][Math.min(attempts - 1, 3)] || 120;
            const nextReconcileAt = new Date(Date.now() + backoffSeconds * 1000);

            await this.prisma.whatsAppStatusEvent.updateMany({
              where: { id: evt.id, reconciled: false },
              data: {
                reconcileAttempts: attempts,
                nextReconcileAt,
                abandoned: isAbandoned,
                lastError: isAbandoned
                  ? `Abandonado tras ${attempts} intentos sin encontrar WhatsAppSendAttempt unívoco. Requiere revisión manual.`
                  : `Reintento ${attempts}/5 programado en ${backoffSeconds}s.`,
              },
            });
          }
        } catch (err: unknown) {
          const error = err as Error;
          this.logger.error(
            `Error al procesar evento de reconciliación [${evt.statusId}]: ${error.message}`,
            error.stack,
            'WhatsAppStatusReconcilerService',
          );

          const attempts = (evt.reconcileAttempts || 0) + 1;
          const isAbandoned = attempts >= 5;
          await this.prisma.whatsAppStatusEvent.updateMany({
            where: { id: evt.id, reconciled: false },
            data: {
              reconcileAttempts: attempts,
              nextReconcileAt: new Date(Date.now() + 60000), // reintentar en 60s
              abandoned: isAbandoned,
              lastError: `Excepción en reconciliación: ${error.message}`,
            },
          });
        }
      }

      if (pendingEvents.length < 50) {
        hasMore = false;
      }
    }

    return reconciledCount;
  }
}
