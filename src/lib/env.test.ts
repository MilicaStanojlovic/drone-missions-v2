import { describe, expect, it } from "vitest";
import { env, loadEnv } from "@/lib/env";

/** A 32+ byte JWT secret, valid for every test that isn't specifically
 * exercising the length rule. */
const VALID_SECRET = "a-valid-test-secret-that-is-at-least-32-bytes-long";

/** Minimal env object containing every field the schema actually requires. */
const BASE_ENV = { JWT_SECRET: VALID_SECRET };

describe("env.ts", () => {
  describe("the process-wide singleton", () => {
    it("parses successfully against the vitest-configured process.env", () => {
      // vitest.config.ts seeds JWT_SECRET for the whole run; everything else
      // is optional/defaulted, so importing env.ts must not throw.
      expect(env.JWT_SECRET.length).toBeGreaterThan(0);
      expect(env.JWT_EXPIRATION_MS).toBe(86400000);
    });
  });

  describe("missing required var fails", () => {
    it("throws when JWT_SECRET is absent", () => {
      expect(() => loadEnv({})).toThrow(/JWT_SECRET/);
    });

    it("lists the field name and reason in the error message", () => {
      expect(() => loadEnv({})).toThrow(/Invalid environment configuration/);
    });
  });

  describe("defaults apply", () => {
    it("defaults JWT_EXPIRATION_MS to 86400000", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.JWT_EXPIRATION_MS).toBe(86400000);
    });

    it("defaults MAIL_ENABLED to false", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.MAIL_ENABLED).toBe(false);
    });

    it("defaults MAIL_FROM to the DroneMissions no-reply address", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.MAIL_FROM).toBe("DroneMissions <no-reply@dronemissions.app>");
    });

    it("defaults PORT to 8085 (mirrors Spring's server.port)", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.PORT).toBe(8085);
    });

    it("leaves DATABASE_URL and FLYWAY_URL undefined when unset", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.DATABASE_URL).toBeUndefined();
      expect(result.FLYWAY_URL).toBeUndefined();
    });

    it("leaves RESEND_API_KEY undefined when unset", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.RESEND_API_KEY).toBeUndefined();
    });

    it('defaults MAIL_REDIRECT_TO to "" (= normal delivery, mirrors app.mail.redirect-to:)', () => {
      const result = loadEnv(BASE_ENV);
      expect(result.MAIL_REDIRECT_TO).toBe("");
    });

    it("defaults APP_URL to http://localhost:8085 (localhost on the PORT default)", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.APP_URL).toBe("http://localhost:8085");
      // The two defaults describe the same origin: a copied .env.example must
      // not serve on one port and link emails at another.
      expect(result.APP_URL).toBe(`http://localhost:${result.PORT}`);
    });
  });

  describe("MAIL_REDIRECT_TO", () => {
    it("keeps a configured redirect address", () => {
      const result = loadEnv({ ...BASE_ENV, MAIL_REDIRECT_TO: "dev@example.com" });
      expect(result.MAIL_REDIRECT_TO).toBe("dev@example.com");
    });

    it("accepts an explicitly empty value instead of rejecting it (blank = normal delivery)", () => {
      const result = loadEnv({ ...BASE_ENV, MAIL_REDIRECT_TO: "" });
      expect(result.MAIL_REDIRECT_TO).toBe("");
    });

    it('normalizes a whitespace-only value to "" (mirrors Spring\'s isBlank check)', () => {
      const result = loadEnv({ ...BASE_ENV, MAIL_REDIRECT_TO: "   " });
      expect(result.MAIL_REDIRECT_TO).toBe("");
    });

    it("trims surrounding whitespace off a real address", () => {
      const result = loadEnv({ ...BASE_ENV, MAIL_REDIRECT_TO: "  dev@example.com  " });
      expect(result.MAIL_REDIRECT_TO).toBe("dev@example.com");
    });
  });

  describe("APP_URL", () => {
    it("accepts an absolute https origin", () => {
      const result = loadEnv({ ...BASE_ENV, APP_URL: "https://dronemissions.example.com" });
      expect(result.APP_URL).toBe("https://dronemissions.example.com");
    });

    it("strips a trailing slash so CTA links never double up", () => {
      const result = loadEnv({ ...BASE_ENV, APP_URL: "https://dronemissions.example.com/" });
      expect(result.APP_URL).toBe("https://dronemissions.example.com");
      expect(`${result.APP_URL}/missions/7`).toBe("https://dronemissions.example.com/missions/7");
    });

    it("rejects a non-URL value", () => {
      expect(() => loadEnv({ ...BASE_ENV, APP_URL: "not a url" })).toThrow(/APP_URL/);
    });

    it('rejects a scheme-less "localhost:8085", which bare URL parsing would accept', () => {
      // WHATWG URL parsing reads "localhost:" as the scheme, so this is a
      // structurally valid URL — it just isn't a usable origin for an email
      // link. The protocol constraint is what catches it.
      expect(() => loadEnv({ ...BASE_ENV, APP_URL: "localhost:8085" })).toThrow(/APP_URL/);
    });

    it("rejects a non-http(s) scheme", () => {
      expect(() => loadEnv({ ...BASE_ENV, APP_URL: "ftp://example.com" })).toThrow(/APP_URL/);
    });

    it("rejects an empty APP_URL", () => {
      expect(() => loadEnv({ ...BASE_ENV, APP_URL: "" })).toThrow(/APP_URL/);
    });
  });

  describe("DATABASE_URL / FLYWAY_URL optional at parse time", () => {
    it("accepts them when present", () => {
      const result = loadEnv({
        ...BASE_ENV,
        DATABASE_URL: "postgres://user:pass@host:5432/db",
        FLYWAY_URL: "jdbc:postgresql://host:5432/db",
      });
      expect(result.DATABASE_URL).toBe("postgres://user:pass@host:5432/db");
      expect(result.FLYWAY_URL).toBe("jdbc:postgresql://host:5432/db");
    });

    it("rejects an explicitly empty DATABASE_URL rather than silently allowing it", () => {
      expect(() => loadEnv({ ...BASE_ENV, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
    });
  });

  describe("bad values rejected", () => {
    it("rejects a JWT_SECRET shorter than 32 bytes", () => {
      expect(() => loadEnv({ JWT_SECRET: "too-short" })).toThrow(/32 bytes/);
    });

    it("accepts a JWT_SECRET of exactly 32 bytes", () => {
      const exactly32 = "x".repeat(32);
      const result = loadEnv({ JWT_SECRET: exactly32 });
      expect(result.JWT_SECRET).toBe(exactly32);
    });

    it("counts multi-byte characters by UTF-8 byte length, not string length", () => {
      // 16 "é" characters = 16 JS string chars but 32 UTF-8 bytes (2 bytes each).
      const sixteenAccented = "é".repeat(16);
      expect(sixteenAccented.length).toBe(16);
      const result = loadEnv({ JWT_SECRET: sixteenAccented });
      expect(result.JWT_SECRET).toBe(sixteenAccented);
    });

    it("rejects a non-numeric JWT_EXPIRATION_MS", () => {
      expect(() => loadEnv({ ...BASE_ENV, JWT_EXPIRATION_MS: "not-a-number" })).toThrow(
        /JWT_EXPIRATION_MS/,
      );
    });

    it("rejects a negative JWT_EXPIRATION_MS", () => {
      expect(() => loadEnv({ ...BASE_ENV, JWT_EXPIRATION_MS: "-1" })).toThrow(/JWT_EXPIRATION_MS/);
    });

    it("coerces a numeric-string JWT_EXPIRATION_MS", () => {
      const result = loadEnv({ ...BASE_ENV, JWT_EXPIRATION_MS: "3600000" });
      expect(result.JWT_EXPIRATION_MS).toBe(3600000);
    });

    it("rejects a MAIL_ENABLED value that is neither true nor false", () => {
      expect(() => loadEnv({ ...BASE_ENV, MAIL_ENABLED: "yes" })).toThrow(/MAIL_ENABLED/);
    });

    it('does not coerce the literal string "false" to true (unlike z.coerce.boolean)', () => {
      const result = loadEnv({ ...BASE_ENV, MAIL_ENABLED: "false" });
      expect(result.MAIL_ENABLED).toBe(false);
    });

    it("accepts MAIL_ENABLED=true case-insensitively", () => {
      const result = loadEnv({ ...BASE_ENV, MAIL_ENABLED: "TRUE" });
      expect(result.MAIL_ENABLED).toBe(true);
    });

    it("rejects a non-numeric PORT", () => {
      expect(() => loadEnv({ ...BASE_ENV, PORT: "abc" })).toThrow(/PORT/);
    });

    it("rejects a zero or negative PORT", () => {
      expect(() => loadEnv({ ...BASE_ENV, PORT: "0" })).toThrow(/PORT/);
    });

    it("rejects an empty RESEND_API_KEY", () => {
      expect(() => loadEnv({ ...BASE_ENV, RESEND_API_KEY: "" })).toThrow(/RESEND_API_KEY/);
    });

    it("accepts a non-empty RESEND_API_KEY", () => {
      const result = loadEnv({ ...BASE_ENV, RESEND_API_KEY: "re_test_key" });
      expect(result.RESEND_API_KEY).toBe("re_test_key");
    });

    it("rejects a LOG_LEVEL outside the pino level set", () => {
      expect(() => loadEnv({ ...BASE_ENV, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
    });

    it("accepts every valid pino LOG_LEVEL", () => {
      for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "silent"]) {
        expect(loadEnv({ ...BASE_ENV, LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
      }
    });

    it("leaves LOG_LEVEL undefined when unset", () => {
      const result = loadEnv(BASE_ENV);
      expect(result.LOG_LEVEL).toBeUndefined();
    });
  });
});
