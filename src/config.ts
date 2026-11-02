import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i).optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT: z.string().default('common'),
  MICROSOFT_EXT_PROP_GUID: z
    .string()
    .default('4d87a1c2-0f3e-4a21-9b76-2c5d8e9f1a30'),

  SYNC_POLL_MS: z.coerce.number().default(750),
  SYNC_MAX_ATTEMPTS: z.coerce.number().default(6),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;

export const googleConfigured = Boolean(
  config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET,
);
export const microsoftConfigured = Boolean(
  config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET,
);

/** Apple needs no app registration -- students supply an app-specific password. */
export const appleConfigured = true;

export function redirectUri(provider: 'google' | 'microsoft'): string {
  return `${config.APP_BASE_URL}/oauth/${provider}/callback`;
}
