import { Injectable, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppLogger } from '../../common/logging/logger.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor';
import { WhatsAppStatusReconcilerService } from './whatsapp-status-reconciler.service';
import {
  NormalizedInboundMessage,
  NormalizedInteractive,
  NormalizedReferral,
  WebhookProcessingResult,
  WhatsAppRawMessage,
  WhatsAppWebhookPayload,
} from './whatsapp.types';

@Injectable()
export class WhatsAppService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueProcessor: WhatsAppQueueProcessor,
    private readonly statusReconciler: WhatsAppStatusReconcilerService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Al inicializar el módulo, activa el procesador durable de la cola.
   */
  async onModuleInit() {
    this.logger.log('WhatsAppService inicializado con cola durable PostgreSQL.', 'WhatsAppService');
  }

  /**
   * Ingesta atómica, durable y no bloqueante del webhook de WhatsApp.
   * Si la persistencia en PostgreSQL falla, LANZA InternalServerErrorException para que Meta reintente.
   * Si la persistencia es exitosa, responde HTTP 200 de inmediato y activa el despachador durable en segundo plano.
   */
  async handleWebhook(payload: WhatsAppWebhookPayload): Promise<WebhookProcessingResult> {
    const result: WebhookProcessingResult = {
      processed: 0,
      duplicates: 0,
      ignored: 0,
      errors: 0,
      details: [],
    };

    if (payload.object !== 'whatsapp_business_account' || !payload.entry) {
      return result;
    }

    let shouldTriggerQueue = false;

    for (const entry of payload.entry) {
      if (!entry.changes) continue;

      for (const change of entry.changes) {
        const value = change.value;
        if (!value) continue;

        // 1. Manejo de estados de entrega (sent, delivered, read, failed)
        if (value.statuses && value.statuses.length > 0) {
          for (const status of value.statuses) {
            this.logger.log(
              `Estado de mensaje WhatsApp recibido: [${status.id}] status=${status.status} recipient=${status.recipient_id}`,
              'WhatsAppService',
            );
            await this.statusReconciler.ingestAndReconcile(status);
            result.ignored++;
            result.details.push({
              externalMessageId: status.id,
              status: 'IGNORED',
            });
          }
        }

        // 2. Ingesta y deduplicación atómica de mensajes de usuarios
        if (value.messages && value.messages.length > 0) {
          for (const message of value.messages) {
            const ingestResult = await this.persistAndDeduplicate(message);

            if (ingestResult.shouldDispatch) {
              shouldTriggerQueue = true;
            }

            if (ingestResult.status === 'RECEIVED') {
              result.processed++;
              result.details.push({
                externalMessageId: ingestResult.externalMessageId,
                status: 'PROCESSED', // Aceptado durablemente en PostgreSQL
              });
            } else if (ingestResult.status === 'DUPLICATE') {
              result.duplicates++;
              result.details.push({
                externalMessageId: ingestResult.externalMessageId,
                status: 'DUPLICATE',
              });
            } else if (ingestResult.status === 'RETRYING') {
              result.processed++;
              result.details.push({
                externalMessageId: ingestResult.externalMessageId,
                status: 'PROCESSED',
              });
            }
          }
        }
      }
    }

    // 3. Activación reactiva del worker durable (validate -> dedupe -> persist -> 200 -> durable queue dispatch)
    if (shouldTriggerQueue) {
      this.queueProcessor.trigger();
    }

    return result;
  }

  /**
   * Persiste atómicamente el mensaje con estado RECEIVED.
   * Si la base de datos falla, arroja excepción fatal para que el webhook responda HTTP 500.
   * Si ya existía el mensaje (P2002), examina su estado para decidir si se reintenta o es un duplicado inocuo.
   */
  private async persistAndDeduplicate(rawMsg: WhatsAppRawMessage): Promise<{
    status: 'RECEIVED' | 'DUPLICATE' | 'RETRYING';
    recordId?: string;
    externalMessageId: string;
    shouldDispatch: boolean;
  }> {
    const normalized = this.normalizeRawMessage(rawMsg);
    const maskedPhone =
      normalized.fromPhone.length > 4 ? `***${normalized.fromPhone.slice(-4)}` : '***';

    this.logger.log(
      `Ingesta de mensaje WhatsApp [${normalized.externalMessageId}] tipo=${normalized.messageType} de=${maskedPhone}`,
      'WhatsAppService',
    );

    try {
      const created = await this.prisma.inboundMessage.create({
        data: {
          externalMessageId: normalized.externalMessageId,
          fromPhone: normalized.fromPhone,
          messageType: normalized.messageType,
          content: normalized.content,
          rawPayload: normalized.rawPayload as Prisma.InputJsonValue,
          status: 'RECEIVED',
          attempts: 0,
        },
      });

      return {
        status: 'RECEIVED',
        recordId: created.id,
        externalMessageId: normalized.externalMessageId,
        shouldDispatch: true,
      };
    } catch (error: unknown) {
      // 1. Manejo de unicidad / reintentos de Meta
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.inboundMessage.findUnique({
          where: { externalMessageId: normalized.externalMessageId },
        });

        if (existing) {
          if (
            existing.status === 'PROCESSED' ||
            existing.responseSent ||
            existing.outboundMessageId
          ) {
            this.logger.log(
              `Mensaje duplicado descartado (ya procesado exitosamente): [${normalized.externalMessageId}]`,
              'WhatsAppService',
            );
            return {
              status: 'DUPLICATE',
              externalMessageId: normalized.externalMessageId,
              shouldDispatch: false,
            };
          }

          // Si quedó en RECEIVED o FAILED, se admite reintento
          this.logger.warn(
            `Reintento detectado para mensaje no completado [${normalized.externalMessageId}] estado previo=${existing.status}. Reprogramando despacho.`,
            'WhatsAppService',
          );
          return {
            status: 'RETRYING',
            recordId: existing.id,
            externalMessageId: normalized.externalMessageId,
            shouldDispatch: true,
          };
        }

        return {
          status: 'DUPLICATE',
          externalMessageId: normalized.externalMessageId,
          shouldDispatch: false,
        };
      }

      // 2. Fallo de persistencia real en PostgreSQL -> LANZAR 500 para forzar reintento de Meta
      const err = error as Error;
      this.logger.error(
        `Fallo crítico de persistencia en PostgreSQL para mensaje [${normalized.externalMessageId}]: ${err.message}`,
        err.stack,
        'WhatsAppService',
      );

      throw new InternalServerErrorException(
        `Error de persistencia en base de datos: el mensaje no pudo ser almacenado de forma durable.`,
      );
    }
  }

  /**
   * Delegación a queueProcessor para compatibilidad de interfaces y tests.
   */
  async dispatchSingleRecord(recordId: string): Promise<boolean> {
    return this.queueProcessor.processRecord(recordId);
  }

  /**
   * Delegación de recuperación masiva a queueProcessor.
   */
  async recoverPendingMessages(): Promise<number> {
    return this.queueProcessor.processPendingQueue();
  }

  /**
   * Normalización completa (S2.04-A):
   * Extrae ID, remitente, tipo, contenido, fecha, mensajes interactivos (botones/listas) y referral.
   */
  normalizeRawMessage(rawMsg: WhatsAppRawMessage): NormalizedInboundMessage {
    const externalMessageId = rawMsg.id;
    const fromPhone = rawMsg.from;
    const messageType = rawMsg.type || 'unknown';
    let content: string | null = null;
    let interactive: NormalizedInteractive | undefined;
    let referral: NormalizedReferral | undefined;

    // 1. Mensaje de texto plano
    if (messageType === 'text' && rawMsg.text?.body) {
      content = rawMsg.text.body.trim();
    }

    // 2. Mensajes interactivos: button_reply o list_reply (S2.04-A)
    if (messageType === 'interactive' && rawMsg.interactive) {
      const inter = rawMsg.interactive;
      if (inter.type === 'button_reply' && inter.button_reply) {
        interactive = {
          type: 'button_reply',
          id: inter.button_reply.id,
          title: inter.button_reply.title,
        };
        content = inter.button_reply.title;
      } else if (inter.type === 'list_reply' && inter.list_reply) {
        interactive = {
          type: 'list_reply',
          id: inter.list_reply.id,
          title: inter.list_reply.title,
          description: inter.list_reply.description,
        };
        content = inter.list_reply.title;
      }
    }

    // 3. Referral (anuncios o enlaces externos) (S2.04-A)
    if (rawMsg.referral) {
      const ref = rawMsg.referral;
      referral = {
        sourceUrl: ref.source_url,
        sourceType: ref.source_type,
        sourceId: ref.source_id,
        headline: ref.headline,
        body: ref.body,
        mediaType: ref.media_type,
        imageUrl: ref.image_url,
        videoUrl: ref.video_url,
      };
    }

    return {
      externalMessageId,
      fromPhone,
      messageType,
      content,
      timestamp: rawMsg.timestamp,
      interactive,
      referral,
      rawPayload: rawMsg as unknown as Record<string, unknown>,
    };
  }
}
