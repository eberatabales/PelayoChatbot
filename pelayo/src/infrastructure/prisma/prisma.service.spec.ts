import { PrismaService } from './prisma.service';
import { AppLogger } from '../../common/logging/logger.service';

describe('PrismaService', () => {
  let service: PrismaService;
  let mockLogger: Partial<AppLogger>;

  beforeEach(() => {
    mockLogger = {
      log: jest.fn(),
      error: jest.fn(),
    };
    service = new PrismaService(mockLogger as AppLogger);
  });

  describe('isHealthy', () => {
    it('debe retornar true cuando la tabla system_checks existe y hay al menos una migración completada', async () => {
      jest
        .spyOn(service, '$queryRaw')
        .mockResolvedValueOnce([{ 1: 1 }]) // SELECT 1 FROM "system_checks"
        .mockResolvedValueOnce([{ exists: true }]); // EXISTS en _prisma_migrations

      const result = await service.isHealthy();
      expect(result).toBe(true);
      expect(service.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('debe retornar false cuando la tabla system_checks no existe', async () => {
      jest
        .spyOn(service, '$queryRaw')
        .mockRejectedValueOnce(new Error('relation "system_checks" does not exist'));

      const result = await service.isHealthy();
      expect(result).toBe(false);
    });

    it('debe retornar false cuando la tabla _prisma_migrations no existe', async () => {
      jest
        .spyOn(service, '$queryRaw')
        .mockResolvedValueOnce([{ 1: 1 }]) // system_checks existe
        .mockRejectedValueOnce(new Error('relation "_prisma_migrations" does not exist'));

      const result = await service.isHealthy();
      expect(result).toBe(false);
    });

    it('debe retornar false cuando _prisma_migrations existe pero no tiene migraciones finalizadas', async () => {
      jest
        .spyOn(service, '$queryRaw')
        .mockResolvedValueOnce([{ 1: 1 }]) // system_checks existe
        .mockResolvedValueOnce([{ exists: false }]); // no hay migraciones finalizadas

      const result = await service.isHealthy();
      expect(result).toBe(false);
    });

    it('debe retornar false cuando la conexión general falla', async () => {
      jest.spyOn(service, '$queryRaw').mockRejectedValue(new Error('Connection lost'));

      const result = await service.isHealthy();
      expect(result).toBe(false);
    });
  });

  describe('onModuleInit', () => {
    it('debe conectar y registrar log de éxito', async () => {
      jest.spyOn(service, '$connect').mockResolvedValue();

      await service.onModuleInit();
      expect(service.$connect).toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(
        'Conexión a PostgreSQL establecida con éxito',
        'PrismaService',
      );
    });

    it('debe capturar errores de conexión sin lanzar excepción no controlada', async () => {
      jest.spyOn(service, '$connect').mockRejectedValue(new Error('Connection refused at 5432'));

      await service.onModuleInit();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('debe desconectar al destruir el módulo', async () => {
      jest.spyOn(service, '$disconnect').mockResolvedValue();

      await service.onModuleDestroy();
      expect(service.$disconnect).toHaveBeenCalled();
    });
  });
});
