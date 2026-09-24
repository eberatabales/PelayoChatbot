import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppLogger } from '../../common/logging/logger.service';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly logger: AppLogger,
    @Optional() options?: Prisma.PrismaClientOptions,
  ) {
    super(options);
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('Conexión a PostgreSQL establecida con éxito', 'PrismaService');
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(
        'Error al conectar a PostgreSQL. Verifica DATABASE_URL.',
        err?.stack,
        'PrismaService',
      );
      // No lanzamos fatal crash aquí para permitir que /health reporte estado unready/degraded
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Conexión a PostgreSQL cerrada', 'PrismaService');
  }

  async isHealthy(): Promise<boolean> {
    try {
      // 1. Comprueba explícitamente la existencia y accesibilidad de la tabla 'system_checks'
      await this.$queryRaw`SELECT 1 FROM "system_checks" LIMIT 1`;

      // 2. Comprueba explícitamente la existencia de '_prisma_migrations' y que haya al menos una migración aplicada
      const result = await this.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL
        ) as exists
      `;

      return Boolean(result[0]?.exists);
    } catch {
      return false;
    }
  }
}
