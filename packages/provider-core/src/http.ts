import { ProviderError, kindFromStatus } from "@click/contracts";
import type { ProviderContext } from "./chatProvider.js";

export interface FetchJsonOptions {
  provider: string;
  model?: string;
  /** Human-readable action used in error messages. */
  action: string;
}

/** Perform a request and throw a normalized {@link ProviderError} on failure. */
export async function request(
  ctx: ProviderContext,
  url: string,
  init: RequestInit,
  options: FetchJsonOptions,
): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError({
        kind: "aborted",
        message: `${options.provider}: ${options.action} was aborted`,
        provider: options.provider,
        model: options.model,
        cause: error,
      });
    }
    throw new ProviderError({
      kind: "network",
      message: `${options.provider}: ${options.action} failed: ${errorMessage(error)}`,
      provider: options.provider,
      model: options.model,
      cause: error,
    });
  }
  return response;
}

/** Assert a 2xx response, mapping error bodies to a normalized error. */
export async function ensureOk(
  response: Response,
  options: FetchJsonOptions & { model?: string },
): Promise<Response> {
  if (response.ok) return response;
  const body = await safeText(response);
  const kind = kindFromStatus(response.status);
  throw new ProviderError({
    kind,
    status: response.status,
    provider: options.provider,
    model: options.model,
    message: `${options.provider}: ${options.action} failed (HTTP ${response.status})${
      body ? `: ${truncate(body, 500)}` : ""
    }`,
  });
}

export async function requestJson<T>(
  ctx: ProviderContext,
  url: string,
  init: RequestInit,
  options: FetchJsonOptions,
): Promise<T> {
  const response = await request(ctx, url, init, options);
  await ensureOk(response, options);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ProviderError({
      kind: "unknown",
      provider: options.provider,
      model: options.model,
      message: `${options.provider}: ${options.action} returned invalid JSON: ${errorMessage(error)}`,
      cause: error,
    });
  }
}

export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedPath}`;
}

export function mergeHeaders(
  ...sources: Array<Record<string, string> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      result[key] = value;
    }
  }
  return result;
}

/** Strip reserved headers that must be controlled by the provider itself. */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const reserved = new Set(["authorization", "content-type", "accept", "host", "content-length"]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (reserved.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
