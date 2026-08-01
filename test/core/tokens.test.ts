import { describe, expect, it } from "vitest";
import {
  CODE_LENGTH,
  TOKEN_LENGTH,
  constantTimeEqual,
  isCodeShaped,
  isTokenShaped,
  mintCode,
  mintToken,
} from "../../src/core/tokens";

describe("mintToken", () => {
  it("is 22 base64url characters", () => {
    for (let i = 0; i < 200; i++) {
      const token = mintToken();
      expect(token).toHaveLength(TOKEN_LENGTH);
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isTokenShaped(token)).toBe(true);
    }
  });

  it("never emits a character that would need URL escaping", () => {
    for (let i = 0; i < 200; i++) {
      const token = mintToken();
      expect(encodeURIComponent(token)).toBe(token);
      expect(token).not.toContain("=");
      expect(token).not.toContain("+");
      expect(token).not.toContain("/");
    }
  });

  it("does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(mintToken());
    expect(seen.size).toBe(500);
  });
});

describe("mintCode", () => {
  it("is always six decimal digits, leading zeros kept", () => {
    for (let i = 0; i < 500; i++) {
      const code = mintCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(isCodeShaped(code)).toBe(true);
    }
  });

  it("covers more than a handful of distinct values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(mintCode());
    expect(seen.size).toBeGreaterThan(250);
  });
});

describe("shape gates", () => {
  it("rejects everything that is not a token", () => {
    for (const value of [
      "",
      "short",
      "0123456789012345678901", // 22 chars but tested below for charset
      "01234567890123456789012", // 23
      "0123456789012345678:01", // bad charset
      "0123456789012345678/01",
      "0123456789012345678+01",
      null,
      undefined,
      22,
      {},
      ["a"],
    ]) {
      const expected = value === "0123456789012345678901";
      expect(isTokenShaped(value)).toBe(expected);
    }
  });

  it("rejects everything that is not a code", () => {
    for (const value of ["", "12345", "1234567", "12345a", " 123456", "123456 ", null, 123456, {}]) {
      expect(isCodeShaped(value)).toBe(false);
    }
    expect(isCodeShaped("000000")).toBe(true);
    expect(isCodeShaped("999999")).toBe(true);
  });
});

describe("constantTimeEqual", () => {
  const cases: [string, string, boolean][] = [
    ["", "", true],
    ["a", "a", true],
    ["a", "b", false],
    ["abc", "abc", true],
    ["abc", "abd", false],
    ["abc", "abcd", false],
    ["abcd", "abc", false],
    ["abc", "", false],
    ["", "abc", false],
    ["ABC", "abc", false],
    ["123456", "123456", true],
    ["000000", "0", false],
    ["é", "é", true],
    ["é", "e", false],
  ];

  for (const [a, b, expected] of cases) {
    it(`${JSON.stringify(a)} vs ${JSON.stringify(b)} is ${String(expected)}`, () => {
      expect(constantTimeEqual(a, b)).toBe(expected);
    });
  }

  it("agrees with === on freshly minted tokens", () => {
    for (let i = 0; i < 50; i++) {
      const token = mintToken();
      expect(constantTimeEqual(token, token)).toBe(true);
      expect(constantTimeEqual(token, mintToken())).toBe(false);
    }
  });

  it("differs in every position and still returns false", () => {
    const a = "aaaaaaaaaaaaaaaaaaaaaa";
    for (let i = 0; i < a.length; i++) {
      const b = `${a.slice(0, i)}b${a.slice(i + 1)}`;
      expect(constantTimeEqual(a, b)).toBe(false);
    }
  });
});
