/** Normalized provider error taxonomy, modelled on Zed's completion errors. */
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "prompt_too_large"
  | "model_not_found"
  | "network"
  | "timeout"
  | "aborted"
  | "unsupported"
  | "unknown";

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  message: string;
  provider?: string;
  model?: string;
  status?: number;
  retryable?: boolean;
  cause?: unknown;
}

/** A single error type every provider throws, so the UI can react uniformly. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = "ProviderError";
    this.kind = options.kind;
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.retryable = options.retryable ?? isRetryableKind(options.kind);
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return kind === "rate_limit" || kind === "overloaded" || kind === "network" || kind === "timeout";
}

/** Map an HTTP status + body to the closest normalized kind. */
export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model_not_found";
  if (status === 408) return "timeout";
  if (status === 413) return "prompt_too_large";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "overloaded";
  return "unknown";
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

export function toProviderError(error: unknown, fallback: Partial<ProviderErrorOptions> = {}): ProviderError {
  if (isProviderError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const kind = fallback.kind ?? classifyNetworkError(error);
  return new ProviderError({ kind, message, ...fallback, cause: error });
}

function classifyNetworkError(error: unknown): ProviderErrorKind {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "network";
}
