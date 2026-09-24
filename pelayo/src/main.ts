import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { AppLogger } from './common/logging/logger.service';

async function bootstrap() {
  const logger = new AppLogger();

  const app = await NestFactory.create(AppModule, {
    logger,
    bufferLogs: true,
    rawBody: true,
  });

  app.enableShutdownHooks();
  app.enableCors();

  app.setGlobalPrefix('api/v1', {
    exclude: ['health'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  await app.listen(port);
  logger.log(
    `🚀 PelayoBot iniciado exitosamente en http://localhost:${port} [Ambiente: ${nodeEnv}]`,
    'Bootstrap',
  );
  logger.log(`🩺 Health check disponible en: http://localhost:${port}/health`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  const logger = new AppLogger();
  const error = err as Error;
  logger.error('Error fatal al arrancar PelayoBot', error?.stack || String(err), 'Bootstrap');
  process.exit(1);
});
