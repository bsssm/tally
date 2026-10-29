/**
 * Keys must never reach logs, errors, or the DB in plaintext.
 * Every error that leaves an adapter passes through `redact` with the secrets in play.
 */

const SECRET_PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{10,}/g, // OpenRouter
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /sk-(?:proj|admin|svcacct)?-?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /Bearer\s+[A-Za-z0-9._-]{16,}/g, // any bearer
];

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** Replace known secrets (and anything that looks like one) in arbitrary text. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join(maskSecret(s));
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => maskSecret(m));
  }
  return out;
}

export class TallyError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string, secrets: readonly string[] = []) {
    super(redact(message, secrets));
    this.name = "TallyError";
    this.code = code;
    this.hint = hint ? redact(hint, secrets) : undefined;
  }
}

/** Convert any thrown value into a TallyError whose message is safe to print. */
export function toSafeError(err: unknown, secrets: readonly string[] = [], code = "unknown"): TallyError {
  if (err instanceof TallyError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new TallyError(code, msg, undefined, secrets);
}
