import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../../common/logging/logger.service';
import { validateWhatsAppWebhookPayload } from './dto/whatsapp-webhook.dto';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhookPayload } from './whatsapp.types';

@Controller('webhooks/whatsapp')
export class WhatsAppController {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * Endpoint GET para el handshake inicial y verificación del Webhook con Meta Cloud API.
   */
  @Get()
  verifyWebhook(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const configuredVerifyToken = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');

    if (mode === 'subscribe' && token === configuredVerifyToken && challenge) {
      this.logger.log(
        'Webhook de WhatsApp verificado con éxito por Meta Graph API',
        'WhatsAppController',
      );
      return challenge;
    }

    this.logger.warn(
      'Intento fallido de verificación de webhook de WhatsApp: token no coincide o parámetros inválidos',
      'WhatsAppController',
    );
    throw new ForbiddenException('Invalid verification token');
  }

  /**
   * Endpoint POST para recepción de notificaciones y mensajes de WhatsApp.
   * 1. Protegido criptográficamente por WhatsAppSignatureGuard (HMAC-SHA256).
   * 2. Validación runtime de payload estructural con Zod (S2.03-A): 400 Bad Request si es malformado.
   * 3. Fallo de DB devuelve 500 sin reconocer recepción.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(WhatsAppSignatureGuard)
  async handleIncomingWebhook(@Body() payload: WhatsAppWebhookPayload) {
    const validatedPayload = validateWhatsAppWebhookPayload(payload);
    const processingResult = await this.whatsappService.handleWebhook(
      validatedPayload as unknown as WhatsAppWebhookPayload,
    );
    return {
      status: 'success',
      ...processingResult,
    };
  }
}
