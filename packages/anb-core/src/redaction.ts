/**
 * ANB Redaction Engine - Zero Plaintext Leakage
 * Masks sensitive values in logs, outputs, and storage.
 */

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /auth(orization)?/i,
  /cookie/i,
  /api[_-]?key/i,
  /credit[-_]?card/i,
  /cvv/i,
  /session[-_]?id/i
];

const VALUE_PATTERNS = [
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-_.]+/gi,
  // Basic auth
  /Basic\s+[A-Za-z0-9+/=]+/gi,
  // API key patterns (OpenAI, Google, Anthropic, generic)
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z\-_]{35}/g,
  /ant-api[A-Za-z0-9\-_]{20,}/g,
  // Generic key assignments
  /(api[_-]?key\s*[:=]\s*["']?)[^"'\s,;]+(["']?)/gi,
  // Password assignments
  /(password\s*[:=]\s*["']?)[^"'\s,;]+(["']?)/gi
];

export function redactText(text: string): string {
  if (!text) return text;
  let redacted = text;
  for (const pattern of VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith('bearer ')) {
        return 'Bearer [REDACTED_TOKEN]';
      }
      if (match.toLowerCase().startsWith('basic ')) {
        return 'Basic [REDACTED_CREDENTIALS]';
      }
      return '[REDACTED_SENSITIVE_VALUE]';
    });
  }
  return redacted;
}

export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactText(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some(pat => pat.test(key));
      if (isSensitiveKey) {
        result[key] = '[REDACTED_SENSITIVE_FIELD]';
      } else {
        result[key] = redactObject(value);
      }
    }
    return result as T;
  }
  return obj;
}
