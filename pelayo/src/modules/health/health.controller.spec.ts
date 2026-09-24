import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HttpStatus } from '@nestjs/common';
import { Response } from 'express';

describe('HealthController', () => {
  let controller: HealthController;
  let mockHealthService: Partial<HealthService>;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    mockHealthService = {
      check: jest.fn(),
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
    };
    controller = new HealthController(mockHealthService as HealthService);
  });

  it('debe responder HTTP 200 cuando el servicio reporta ok', async () => {
    (mockHealthService.check as jest.Mock).mockResolvedValue({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: 10,
      environment: 'test',
      services: { database: 'connected' },
    });

    const result = await controller.getHealth(mockResponse as Response);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(result.status).toBe('ok');
  });

  it('debe responder HTTP 503 cuando el servicio reporta degraded', async () => {
    (mockHealthService.check as jest.Mock).mockResolvedValue({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      uptime: 10,
      environment: 'test',
      services: { database: 'disconnected' },
    });

    const result = await controller.getHealth(mockResponse as Response);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result.status).toBe('degraded');
  });
});
