/**
 * Branded identifier types. Brands prevent accidental mixing of ids at
 * compile time while remaining plain strings at runtime.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProviderId = Brand<string, "ProviderId">;
export type ModelId = Brand<string, "ModelId">;
export type ToolCallId = Brand<string, "ToolCallId">;

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

/**
 * Provider ids are Click's own slugs, so they stay strict. Model ids, however,
 * come straight from vendors and legitimately contain separators such as
 * `openai/gpt-5`, `qwen2.5-coder:7b`, or `@cf/meta/llama-3`. Allow any
 * non-whitespace, non-control token so real catalogs are never rejected.
 */
const MODEL_ID_PATTERN = /^[^\s\u0000-\u001f]{1,200}$/;

function makeId<T extends string>(value: string, label: string): T {
  const trimmed = value.trim();
  if (!ID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return trimmed as T;
}

export const ProviderId = {
  make: (value: string): ProviderId => makeId<ProviderId>(value, "provider id"),
  is: (value: unknown): value is ProviderId =>
    typeof value === "string" && ID_PATTERN.test(value),
};

export const ModelId = {
  make: (value: string): ModelId => {
    const trimmed = value.trim();
    if (!MODEL_ID_PATTERN.test(trimmed)) {
      throw new Error(`Invalid model id: ${JSON.stringify(value)}`);
    }
    return trimmed as ModelId;
  },
  is: (value: unknown): value is ModelId =>
    typeof value === "string" && MODEL_ID_PATTERN.test(value),
};

export const ToolCallId = {
  make: (value: string): ToolCallId => makeId<ToolCallId>(value, "tool call id"),
};
