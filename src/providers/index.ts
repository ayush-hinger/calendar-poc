import type { ProviderId } from '../domain/types.ts';
import type { CalendarProvider } from './types.ts';
import { logProvider } from './log.ts';
import { googleProvider } from './google.ts';
import { microsoftProvider } from './microsoft.ts';
import { appleProvider } from './apple.ts';

const registry: Record<ProviderId, CalendarProvider> = {
  log: logProvider,
  google: googleProvider,
  microsoft: microsoftProvider,
  apple: appleProvider,
};

export function providerFor(id: ProviderId): CalendarProvider {
  const provider = registry[id];
  if (!provider) throw new Error(`Unknown calendar provider: ${id}`);
  return provider;
}

export const providerLabels: Record<ProviderId, string> = {
  log: logProvider.label,
  google: googleProvider.label,
  microsoft: microsoftProvider.label,
  apple: appleProvider.label,
};
