export interface RunSubmissionFingerprintInput {
  readonly engine: string;
  readonly text: string;
}

export interface IdempotencyTracker {
  keyFor(scope: string, payload: RunSubmissionFingerprintInput): string;
  peek(scope: string): { readonly key: string; readonly fingerprint: string } | undefined;
  clear(scope: string): void;
}

function fingerprintPayload(payload: RunSubmissionFingerprintInput): string {
  return JSON.stringify([payload.engine, payload.text]);
}

function defaultKeyGenerator(): string {
  return `web_${crypto.randomUUID()}`;
}

export function createIdempotencyTracker(
  generateKey: () => string = defaultKeyGenerator,
): IdempotencyTracker {
  const entries = new Map<string, { readonly key: string; readonly fingerprint: string }>();

  return {
    keyFor(scope: string, payload: RunSubmissionFingerprintInput): string {
      const fingerprint = fingerprintPayload(payload);
      const existing = entries.get(scope);
      if (existing && existing.fingerprint === fingerprint) {
        return existing.key;
      }
      const next = { key: generateKey(), fingerprint };
      entries.set(scope, next);
      return next.key;
    },
    peek(scope: string) {
      return entries.get(scope);
    },
    clear(scope: string): void {
      entries.delete(scope);
    },
  };
}
