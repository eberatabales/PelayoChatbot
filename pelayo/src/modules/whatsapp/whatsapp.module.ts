import { Module } from '@nestjs/common';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor';
import { WhatsAppSenderAdapter } from './whatsapp-sender.adapter';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard';
import { WhatsAppStatusReconcilerService } from './whatsapp-status-reconciler.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';

@Module({
  controllers: [WhatsAppController],
  providers: [
    WhatsAppService,
    WhatsAppQueueProcessor,
    WhatsAppSenderAdapter,
    WhatsAppSignatureGuard,
    WhatsAppStatusReconcilerService,
  ],
  exports: [
    WhatsAppService,
    WhatsAppQueueProcessor,
    WhatsAppSenderAdapter,
    WhatsAppStatusReconcilerService,
  ],
})
export class WhatsAppModule {}
