import { HealthService } from './health.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

describe('HealthService', () => {
  let healthService: HealthService;
  let mockPrismaService: Partial<PrismaService>;

  beforeEach(() => {
    mockPrismaService = {
      isHealthy: jest.fn(),
    };
    healthService = new HealthService(mockPrismaService as PrismaService);
  });

  it('debe retornar status "ok" y database "connected" cuando Prisma responde saludablemente', async () => {
    (mockPrismaService.isHealthy as jest.Mock).mockResolvedValue(true);

    const result = await healthService.check();

    expect(result.status).toBe('ok');
    expect(result.services.database).toBe('connected');
    expect(result.timestamp).toBeDefined();
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('debe retornar status "degraded" y database "disconnected" cuando Prisma falla', async () => {
    (mockPrismaService.isHealthy as jest.Mock).mockResolvedValue(false);

    const result = await healthService.check();

    expect(result.status).toBe('degraded');
    expect(result.services.database).toBe('disconnected');
  });
});
