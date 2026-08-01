// Session tokens, pairing codes, constant-time comparison.
//
// Only dependency is Web Crypto: the `crypto` global, i.e. `globalThis.crypto`,
// which exists both in Workers and in Node >= 20, so this module is
// unit-testable outside Workers. It is referenced as a bare global rather than
// through `globalThis` because @cloudflare/workers-types declares it that way.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 128 bits of entropy, per docs/CONTRACTS.md § Identity and pairing. */
export const TOKEN_BYTES = 16;
/** ceil(16 * 8 / 6) = 22 unpadded base64url characters. */
export const TOKEN_LENGTH = 22;
export const CODE_LENGTH = 6;

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const CODE_RE = /^[0-9]{6}$/;

/**
 * Unpadded base64url. Hand-rolled rather than `btoa` so this module needs no
 * global beyond crypto and cannot emit `+`, `/` or `=` into a URL path.
 * `charAt` is used instead of indexing because `noUncheckedIndexedAccess`
 * widens string indexing to `string | undefined`.
 */
function base64url(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += ALPHABET.charAt(b0 >> 2);
    out += ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (i + 1 < n) out += ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    if (i + 2 < n) out += ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}

/** 22-char base64url capability token. Appears only as a URL path segment. */
export function mintToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * Six decimal digits, leading zeros preserved. Rejection sampling keeps the
 * distribution uniform: a plain `% 1e6` over 2^32 would bias the low codes.
 */
export function mintCode(): string {
  const span = 1_000_000;
  const bound = Math.floor(0x1_0000_0000 / span) * span;
  const buf = new Uint32Array(1);
  let v = bound;
  while (v >= bound) {
    crypto.getRandomValues(buf);
    v = buf[0] ?? 0;
  }
  return String(v % span).padStart(CODE_LENGTH, "0");
}

/**
 * Length-independent-in-content comparison for secrets. Length itself is not
 * secret here (both operands are fixed-width by construction), so an early
 * length exit is fine; the content compare accumulates XOR over every
 * character so it cannot short-circuit on the first mismatching byte.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Shape gate applied before a token is ever used to name a Durable Object. */
export function isTokenShaped(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

export function isCodeShaped(value: unknown): value is string {
  return typeof value === "string" && CODE_RE.test(value);
}
