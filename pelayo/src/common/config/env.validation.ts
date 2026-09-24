import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z
      .string()
      .regex(/^\d+$/, {
        message: 'PORT must be an integer string containing only digits (e.g. "3000")',
      })
      .default('3000')
      .transform((val: string) => Number(val))
      .refine((val: number) => Number.isInteger(val) && val >= 1 && val <= 65535, {
        message: 'PORT must be a valid integer between 1 and 65535',
      }),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url({
        message: 'DATABASE_URL must be a valid URL',
      })
      .refine(
        (val: string) => {
          try {
            const parsed = new URL(val);
            return parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:';
          } catch {
            return false;
          }
        },
        {
          message:
            'DATABASE_URL must use the postgresql:// or postgres:// protocol (e.g. postgresql://user:pass@host:5432/db)',
        },
      ),
    // WhatsApp Cloud API Configuration (Sprint 2)
    WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),
    WHATSAPP_API_TOKEN: z.string().min(1).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
    WHATSAPP_API_URL: z
      .string()
      .url({ message: 'WHATSAPP_API_URL must be a valid URL' })
      .default('https://graph.facebook.com/v21.0'),
  })
  .transform((data) => {
    // En entornos test o development, asignamos fallbacks solo si no fueron provistos explícitamente
    if (data.NODE_ENV !== 'production') {
      return {
        ...data,
        WHATSAPP_VERIFY_TOKEN: data.WHATSAPP_VERIFY_TOKEN || 'pelayo_bot_test_verify_token_2026',
        WHATSAPP_APP_SECRET: data.WHATSAPP_APP_SECRET || 'test_app_secret_32_chars_long_1234',
        WHATSAPP_API_TOKEN: data.WHATSAPP_API_TOKEN || 'test_meta_api_token_placeholder',
        WHATSAPP_PHONE_NUMBER_ID: data.WHATSAPP_PHONE_NUMBER_ID || '100000000000001',
      };
    }
    return data;
  })
  .superRefine((data, ctx) => {
    // En producción, es OBLIGATORIO proveer credenciales reales y se prohíben valores por defecto o placeholders
    if (data.NODE_ENV === 'production') {
      if (!data.WHATSAPP_VERIFY_TOKEN || data.WHATSAPP_VERIFY_TOKEN.includes('placeholder')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WHATSAPP_VERIFY_TOKEN'],
          message:
            'En producción, WHATSAPP_VERIFY_TOKEN es obligatorio y no puede usar valores de prueba o placeholder.',
        });
      }

      if (
        !data.WHATSAPP_APP_SECRET ||
        data.WHATSAPP_APP_SECRET.length < 16 ||
        data.WHATSAPP_APP_SECRET.includes('test_app_secret')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WHATSAPP_APP_SECRET'],
          message:
            'En producción, WHATSAPP_APP_SECRET es obligatorio, debe tener al menos 16 caracteres y no puede usar secretos de prueba predeterminados.',
        });
      }

      if (
        !data.WHATSAPP_API_TOKEN ||
        data.WHATSAPP_API_TOKEN.includes('placeholder') ||
        data.WHATSAPP_API_TOKEN.includes('test_meta')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WHATSAPP_API_TOKEN'],
          message:
            'En producción, WHATSAPP_API_TOKEN es obligatorio y no puede usar tokens de prueba o placeholder.',
        });
      }

      if (!data.WHATSAPP_PHONE_NUMBER_ID || data.WHATSAPP_PHONE_NUMBER_ID === '100000000000001') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WHATSAPP_PHONE_NUMBER_ID'],
          message:
            'En producción, WHATSAPP_PHONE_NUMBER_ID es obligatorio y debe ser un ID de teléfono real de Meta Cloud API.',
        });
      }
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnvironment(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const formattedErrors = result.error.errors
      .map((err) => `  - [${err.path.join('.')}] ${err.message}`)
      .join('\n');

    throw new Error(
      `\n❌ Configuración de entorno inválida o incompleta:\n${formattedErrors}\nPor favor revisa el archivo .env o .env.example.\n`,
    );
  }

  return result.data;
}
