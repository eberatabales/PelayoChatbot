import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';
import { AppLogger } from '../../common/logging/logger.service';

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

@Injectable()
export class WhatsAppSignatureGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithRawBody>();
    const appSecret = this.configService.get<string>('WHATSAPP_APP_SECRET');

    // Si no está configurado el secreto en entorno productivo/desarrollo, se rechaza
    if (!appSecret) {
      this.logger.error(
        'WHATSAPP_APP_SECRET no está configurado en las variables de entorno',
        undefined,
        'WhatsAppSignatureGuard',
      );
      throw new UnauthorizedException('WhatsApp app secret is not configured');
    }

    const signatureHeader = request.headers['x-hub-signature-256'];
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      this.logger.warn(
        'Petición entrante de WhatsApp rechazada: Falta cabecera x-hub-signature-256',
        'WhatsAppSignatureGuard',
      );
      throw new UnauthorizedException('Missing x-hub-signature-256 header');
    }

    if (!signatureHeader.startsWith('sha256=')) {
      this.logger.warn(
        'Petición entrante de WhatsApp rechazada: Formato de firma inválido',
        'WhatsAppSignatureGuard',
      );
      throw new UnauthorizedException('Invalid signature format. Must start with sha256=');
    }

    const signatureHash = signatureHeader.substring(7).trim();

    // Obtener el buffer original sin transformar (rawBody)
    const rawBody = request.rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      this.logger.error(
        'rawBody no está disponible en la petición. Asegúrate de que NestJS esté configurado con rawBody: true',
        undefined,
        'WhatsAppSignatureGuard',
      );
      throw new UnauthorizedException('Raw body unavailable for signature validation');
    }

    const calculatedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    const signatureBuffer = Buffer.from(signatureHash, 'hex');
    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');

    if (
      signatureBuffer.length !== calculatedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, calculatedBuffer)
    ) {
      this.logger.warn(
        'Petición entrante de WhatsApp rechazada: Firma criptográfica no coincide',
        'WhatsAppSignatureGuard',
      );
      throw new UnauthorizedException('Invalid WhatsApp signature');
    }

    return true;
  }
}
