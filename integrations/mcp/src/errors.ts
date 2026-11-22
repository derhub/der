import type { EffectIdentity } from "@der/domain";

export class ToolEffectUncertainError extends Error {
  readonly code = "effect.outcome_uncertain";
  readonly effect: EffectIdentity;

  constructor(effect: EffectIdentity, message: string) {
    super(message);
    this.name = "ToolEffectUncertainError";
    this.effect = effect;
  }
}

export class ToolConfigurationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolConfigurationError";
    this.code = code;
  }
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let sanitized = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }
  return sanitized;
}
