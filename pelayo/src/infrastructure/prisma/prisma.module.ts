import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { AppLogger } from '../../common/logging/logger.service';

@Global()
@Module({
  providers: [PrismaService, AppLogger],
  exports: [PrismaService, AppLogger],
})
export class PrismaModule {}
