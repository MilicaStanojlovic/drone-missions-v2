import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

/**
 * Vitest suite for `password.ts`.
 *
 * The Spring-interop fixture below is a genuine `$2a$`, cost-10 BCrypt hash
 * — the exact format `new BCryptPasswordEncoder()` (SecurityConfig's
 * `passwordEncoder` bean) emits — generated with an independent, standard
 * BCrypt implementation (Python's `bcrypt` package, itself a binding over
 * the reference OpenBSD BCrypt algorithm Spring's own implementation is
 * also a port of). It was **not** produced by literally running the Java
 * backend: building/running the source repos is out of scope for this
 * read-only port (see the implementer role's rules), and the sandbox has
 * no route to Maven Central to fetch `spring-security-crypto` either. BCrypt
 * is a fully-specified, deterministic algorithm with no Spring-specific
 * behavior in its `$2a$` output, so this is equivalent in every way that
 * matters for this test: proving `bcryptjs` verifies a `$2a$`-prefixed,
 * cost-10 hash it did not itself produce, which is exactly the risk this
 * port carries (existing users' stored hashes must keep verifying).
 *
 * SOURCE: drone-missions-backend/.../config/SecurityConfig.java (passwordEncoder bean).
 */
describe("password.ts", () => {
  describe("hashPassword / verifyPassword round-trip", () => {
    it("verifies a password against its own freshly-minted hash", async () => {
      const hash = await hashPassword("Sup3rSecret!");
      await expect(verifyPassword("Sup3rSecret!", hash)).resolves.toBe(true);
    });

    it("rejects the wrong password against a freshly-minted hash", async () => {
      const hash = await hashPassword("Sup3rSecret!");
      await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
    });

    it("produces a cost-factor-10 hash, matching BCryptPasswordEncoder's default strength", async () => {
      // bcryptjs always mints the "$2b$" revision (no option to force "$2a$" —
      // see the discrepancy note on hashPassword()); verification of both
      // revisions is unaffected and covered by the Spring-hash fixture below.
      const hash = await hashPassword("Sup3rSecret!");
      expect(hash).toMatch(/^\$2b\$10\$/);
    });

    it("salts each hash independently (two hashes of the same password differ)", async () => {
      const [first, second] = await Promise.all([
        hashPassword("Sup3rSecret!"),
        hashPassword("Sup3rSecret!"),
      ]);
      expect(first).not.toBe(second);
    });
  });

  describe("verifies an existing Spring BCrypt hash unchanged (fixture)", () => {
    const SPRING_FORMAT_HASH = "$2a$10$GPcdnQX2mFb0NTNAbsMicODL5AxNgoHGFaRv3zK2b0qpQs03HyJTC";
    const RAW_PASSWORD = "correct horse battery staple";

    it("verifies the correct password against the pre-existing hash", async () => {
      await expect(verifyPassword(RAW_PASSWORD, SPRING_FORMAT_HASH)).resolves.toBe(true);
    });

    it("rejects an incorrect password against the pre-existing hash", async () => {
      await expect(verifyPassword("not the password", SPRING_FORMAT_HASH)).resolves.toBe(false);
    });
  });
});
