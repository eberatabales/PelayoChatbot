import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../../common/logging/logger.service';
import { classifyMetaError } from './whatsapp-error-classifier';
import { SendResult, WhatsAppSendResponse } from './whatsapp.types';

@Injectable()
export class WhatsAppSenderAdapter {
  private readonly apiUrl: string;
  private readonly phoneNumberId: string;
  private readonly apiToken: string;
  private readonly requestTimeoutMs = 2500;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: AppLogger,
  ) {
    this.apiUrl = this.configService.get<string>(
      'WHATSAPP_API_URL',
      'https://graph.facebook.com/v21.0',
    );
    this.phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID', '');
    this.apiToken = this.configService.get<string>('WHATSAPP_API_TOKEN', '');
  }

  /**
   * Envía un mensaje de texto plano a un destinatario de WhatsApp.
   * Clasifica rigurosamente el resultado operativo (S2.09-B):
   * - EXPLICIT_RETRYABLE: Rechazo transitorio de Meta (131016, 131032, 80007, 429, 5xx).
   * - EXPLICIT_FATAL: Error definitivo de cuenta/sandbox/plantilla/parámetro (131030, 131031, 190, 100, etc.).
   * - UNCERTAIN_TIMEOUT: Timeout de red esperando confirmación.
   * - INVALID_RESPONSE: HTTP 200 pero cuerpo malformado o sin messageId válido.
   * - NETWORK_ERROR: Fallo al abrir socket o resolver DNS.
   */
  async sendTextMessage(
    toPhone: string,
    text: string,
    bizOpaqueCallbackData?: string,
  ): Promise<SendResult> {
    if (!this.phoneNumberId || !this.apiToken) {
      const errorMsg = 'WhatsAppSenderAdapter: PHONE_NUMBER_ID o API_TOKEN no están configurados';
      this.logger.error(errorMsg, undefined, 'WhatsAppSenderAdapter');
      return { success: false, errorType: 'CONFIG_ERROR', error: errorMsg };
    }

    const endpoint = `${this.apiUrl.replace(/\/$/, '')}/${this.phoneNumberId}/messages`;
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    };

    if (bizOpaqueCallbackData) {
      payload.biz_opaque_callback_data = bizOpaqueCallbackData;
    }

    const maskedPhone = toPhone.length > 4 ? `***${toPhone.slice(-4)}` : '***';

    try {
      this.logger.log(`Enviando mensaje de WhatsApp a ${maskedPhone}...`, 'WhatsAppSenderAdapter');

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      const responseBody = await response.json().catch(() => ({}));

      if (!response.ok) {
        const metaError = (responseBody as { error?: { message?: string; code?: number } })?.error;
        const code = metaError?.code;
        const classified = classifyMetaError({
          httpStatus: response.status,
          metaCode: code,
          rawMessage: metaError?.message,
        });

        this.logger.error(
          `Fallo al enviar mensaje a ${maskedPhone}: ${classified.message}${classified.userFacingAction ? ` [Acción: ${classified.userFacingAction}]` : ''}`,
          undefined,
          'WhatsAppSenderAdapter',
        );

        return {
          success: false,
          errorType: classified.classification,
          error: classified.message,
          rawResponse: responseBody,
        };
      }

      const sendResponse = responseBody as WhatsAppSendResponse;
      const messageId = sendResponse.messages?.[0]?.id;

      // Validación estricta: un HTTP 200 sin messageId no es éxito confirmado
      if (!messageId || typeof messageId !== 'string' || messageId.trim() === '') {
        const errDesc = 'Meta API respondió HTTP 200 pero sin message ID válido';
        this.logger.error(
          `Respuesta anómala de Meta API para ${maskedPhone}: ${errDesc}`,
          undefined,
          'WhatsAppSenderAdapter',
        );

        return {
          success: false,
          errorType: 'INVALID_RESPONSE',
          error: errDesc,
          rawResponse: responseBody,
        };
      }

      this.logger.log(
        `Mensaje de WhatsApp enviado exitosamente a ${maskedPhone}. MessageId: ${messageId}`,
        'WhatsAppSenderAdapter',
      );

      return {
        success: true,
        messageId,
        rawResponse: responseBody,
      };
    } catch (error: unknown) {
      const err = error as Error;
      const isTimeout =
        err.name === 'TimeoutError' ||
        err.message?.includes('timeout') ||
        err.name === 'AbortError';

      const errorType = isTimeout ? 'UNCERTAIN_TIMEOUT' : 'NETWORK_ERROR';
      const errorMessage = isTimeout
        ? `Timeout (${this.requestTimeoutMs}ms) esperando respuesta de Meta API`
        : `Error de red al conectar con Meta API: ${err.message}`;

      this.logger.error(
        `Excepción enviando mensaje a ${maskedPhone}: ${errorMessage}`,
        err.stack,
        'WhatsAppSenderAdapter',
      );

      return {
        success: false,
        errorType,
        error: errorMessage,
      };
    }
  }
}
