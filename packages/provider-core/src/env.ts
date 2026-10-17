export interface EnvRecord {
  [key: string]: string | undefined;
}

/**
 * Resolve an API key: explicit config wins, then the given environment
 * variable names in order, then a provider-specific `_API_KEY` convention.
 */
export function resolveApiKey(
  configured: string | undefined,
  env: EnvRecord,
  envVarNames: string[],
): string | undefined {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  for (const name of envVarNames) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function baseUrl(configured: string | undefined, fallback: string): string {
  const trimmed = configured?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}
