export class SpineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "SpineError";
  }
}

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpineError("INVALID_DATA", `Expected an object at ${path}.`, { path });
  }
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SpineError("INVALID_DATA", `Expected an array at ${path}.`, { path });
  }
  return value;
}
