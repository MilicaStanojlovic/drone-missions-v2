import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { signJwt, verifyJwt, InvalidJwtError } from "./jwt";
import { env } from "@/lib/env";

/**
 * Vitest suite for `jwt.ts`.
 *
 * SOURCE:
 * - drone-missions-backend/.../config/SecurityConfig.java (jwtSecretKey, jwtDecoder, jwtEncoder beans)
 * - drone-missions-backend/.../business/service/auth/AuthService.java (generateToken)
 */
describe("jwt.ts", () => {
  describe("signJwt / verifyJwt round-trip", () => {
    it("round-trips the user id as a string sub claim and the role claim", async () => {
      const token = await signJwt(42, "PILOT");
      const claims = await verifyJwt(token);
      expect(claims.sub).toBe("42");
      expect(claims.role).toBe("PILOT");
    });

    it("sets iat to now and exp to now + JWT_EXPIRATION_MS (in whole seconds)", async () => {
      const before = Math.floor(Date.now() / 1000);
      const token = await signJwt(1, "DESIGNER");
      const after = Math.floor(Date.now() / 1000);
      const claims = await verifyJwt(token);

      expect(claims.iat).toBeGreaterThanOrEqual(before);
      expect(claims.iat).toBeLessThanOrEqual(after);
      expect(claims.exp - claims.iat).toBe(Math.round(env.JWT_EXPIRATION_MS / 1000));
    });

    it("produces a compact JWT with an HS256 header", async () => {
      const token = await signJwt(7, "ADMIN");
      const [headerB64] = token.split(".");
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
      expect(header.alg).toBe("HS256");
    });
  });

  describe("bad signature / malformed token rejected", () => {
    it("rejects a token signed with a different secret", async () => {
      const foreignKey = new TextEncoder().encode("a-completely-different-secret-key-32bytes!!");
      const foreignToken = await new SignJWT({ role: "PILOT" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("1")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(foreignKey);

      await expect(verifyJwt(foreignToken)).rejects.toBeInstanceOf(InvalidJwtError);
    });

    it("rejects a malformed (non-JWT) string", async () => {
      await expect(verifyJwt("not-a-real-jwt")).rejects.toBeInstanceOf(InvalidJwtError);
    });

    it("rejects a token with a tampered payload segment", async () => {
      const token = await signJwt(1, "PILOT");
      const [header, , signature] = token.split(".");
      const tamperedPayload = Buffer.from(JSON.stringify({ sub: "999", role: "ADMIN" })).toString(
        "base64url",
      );
      await expect(verifyJwt(`${header}.${tamperedPayload}.${signature}`)).rejects.toBeInstanceOf(
        InvalidJwtError,
      );
    });
  });

  describe("expiry", () => {
    it("rejects an already-expired token", async () => {
      const secretKey = new TextEncoder().encode(env.JWT_SECRET);
      const expiredToken = await new SignJWT({ role: "PILOT" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("1")
        .setIssuedAt(new Date(Date.now() - 60_000))
        .setExpirationTime(new Date(Date.now() - 1_000))
        .sign(secretKey);

      await expect(verifyJwt(expiredToken)).rejects.toBeInstanceOf(InvalidJwtError);
    });

    it("accepts a token that has not yet expired", async () => {
      const secretKey = new TextEncoder().encode(env.JWT_SECRET);
      const freshToken = await new SignJWT({ role: "PILOT" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("1")
        .setIssuedAt()
        .setExpirationTime(new Date(Date.now() + 60_000))
        .sign(secretKey);

      await expect(verifyJwt(freshToken)).resolves.toMatchObject({ sub: "1", role: "PILOT" });
    });
  });
});
