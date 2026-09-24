import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Esquema Zod de validación estricta en tiempo de ejecución para Payloads de Meta WhatsApp Webhook (S2.03-A).
 * Distingue payloads malformados (rechazados con HTTP 400 Bad Request)
 * de caídas transitorias de infraestructura o bases de datos (HTTP 500 para reintento).
 */
export const WhatsAppRawMessageSchema = z
  .object({
    from: z.string().min(1, 'El remitente no puede estar vacío'),
    id: z.string().min(1, 'El external message ID no puede estar vacío'),
    timestamp: z.string(),
    type: z.string(),
    text: z
      .object({
        body: z.string(),
      })
      .optional(),
    image: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
        sha256: z.string().optional(),
        caption: z.string().optional(),
      })
      .optional(),
    audio: z
      .object({
        id: z.string(),
        mime_type: z.string().optional(),
      })
      .optional(),
    document: z
      .object({
        id: z.string(),
        filename: z.string().optional(),
        mime_type: z.string().optional(),
      })
      .optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z
          .object({
            id: z.string(),
            title: z.string(),
          })
          .optional(),
        list_reply: z
          .object({
            id: z.string(),
            title: z.string(),
            description: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    referral: z
      .object({
        source_url: z.string().optional(),
        source_type: z.string().optional(),
        source_id: z.string().optional(),
        headline: z.string().optional(),
        body: z.string().optional(),
        media_type: z.string().optional(),
        image_url: z.string().optional(),
        video_url: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

export const WhatsAppRawStatusSchema = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string(),
  })
  .passthrough();

export const WhatsAppChangeValueSchema = z
  .object({
    messaging_product: z.string(),
    metadata: z.object({
      display_phone_number: z.string().optional(),
      phone_number_id: z.string(),
    }),
    contacts: z
      .array(
        z.object({
          profile: z.object({ name: z.string() }).optional(),
          wa_id: z.string(),
        }),
      )
      .optional(),
    messages: z.array(WhatsAppRawMessageSchema).optional(),
    statuses: z.array(WhatsAppRawStatusSchema).optional(),
  })
  .passthrough();

export const WhatsAppWebhookSchema = z
  .object({
    object: z.literal('whatsapp_business_account', {
      errorMap: () => ({ message: 'El campo object debe ser "whatsapp_business_account"' }),
    }),
    entry: z
      .array(
        z.object({
          id: z.string(),
          changes: z.array(
            z.object({
              value: WhatsAppChangeValueSchema,
              field: z.string(),
            }),
          ),
        }),
      )
      .min(1, 'El array entry debe contener al menos un elemento'),
  })
  .passthrough();

export type ValidatedWhatsAppWebhookPayload = z.infer<typeof WhatsAppWebhookSchema>;

export function validateWhatsAppWebhookPayload(
  rawPayload: unknown,
): ValidatedWhatsAppWebhookPayload {
  const parseResult = WhatsAppWebhookSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues
      .map((issue) => `[${issue.path.join('.') || 'root'}]: ${issue.message}`)
      .join('; ');
    throw new BadRequestException(
      `Payload de webhook de WhatsApp inválido o malformado: ${errorDetails}`,
    );
  }
  return parseResult.data;
}
