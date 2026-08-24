import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "@/features/auth/server/auth.schema";

/**
 * Vitest suite for `auth.schema.ts` — DB-less coverage of every
 * `@NotBlank`/`@Email`/`@Size`/`@NotNull` rule ported from
 * `RegisterRequest`/`LoginRequest`, including the whitespace-only cases
 * `@NotBlank` rejects that a bare `.min(1)`/`.min(8)` would silently accept.
 *
 * SOURCE:
 * - drone-missions-backend/.../web/dto/auth/RegisterRequest.java
 * - drone-missions-backend/.../web/dto/auth/LoginRequest.java
 */
describe("registerSchema", () => {
  const valid = {
    username: "mira",
    email: "mira@example.com",
    password: "Sup3rSecret!",
    role: "PILOT",
  };

  it("accepts a well-formed payload", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing username", () => {
    const result = registerSchema.safeParse({ ...valid, username: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only username, mirroring @NotBlank", () => {
    const result = registerSchema.safeParse({ ...valid, username: "   " });
    expect(result.success).toBe(false);
  });

  it("accepts a padded-but-otherwise-valid username WITHOUT trimming it, mirroring @NotBlank (check, not mutate)", () => {
    // `AuthService.createUser` calls `user.setUsername(username)` with no
    // trim, so the stored value must be byte-identical to what was
    // submitted — a schema-level `.trim()` transform here would silently
    // store a different value than Spring does for the same input.
    const result = registerSchema.safeParse({ ...valid, username: "  mira  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.username).toBe("  mira  ");
    }
  });

  it("rejects a malformed email, mirroring @Email", () => {
    const result = registerSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing email", () => {
    const result = registerSchema.safeParse({ ...valid, email: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a password under 8 characters, mirroring @Size(min = 8)", () => {
    const result = registerSchema.safeParse({ ...valid, password: "short1" });
    expect(result.success).toBe(false);
  });

  it("rejects an 8-character whitespace-only password, mirroring @NotBlank on top of @Size", () => {
    const result = registerSchema.safeParse({ ...valid, password: "        " });
    expect(result.success).toBe(false);
  });

  it("accepts a password with leading/trailing whitespace as long as it is non-blank and >=8 chars untrimmed", () => {
    // @Size(min = 8) measures the untrimmed value in the source, so this
    // field is never trimmed before either check — only unmasks a fully
    // blank value.
    const result = registerSchema.safeParse({ ...valid, password: "  abcd  " });
    expect(result.success).toBe(true);
  });

  it("rejects a missing role, mirroring @NotNull", () => {
    const withoutRole: Record<string, unknown> = { ...valid };
    delete withoutRole.role;
    const result = registerSchema.safeParse(withoutRole);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown role value", () => {
    const result = registerSchema.safeParse({ ...valid, role: "SUPERUSER" });
    expect(result.success).toBe(false);
  });

  it("accepts ADMIN at the schema layer — the self-registration guard is a runtime rule, not a schema restriction", () => {
    const result = registerSchema.safeParse({ ...valid, role: "ADMIN" });
    expect(result.success).toBe(true);
  });
});

describe("loginSchema", () => {
  const valid = { email: "mira@example.com", password: "Sup3rSecret!" };

  it("accepts a well-formed payload", () => {
    expect(loginSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing email", () => {
    const result = loginSchema.safeParse({ ...valid, email: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only email, mirroring @NotBlank", () => {
    const result = loginSchema.safeParse({ ...valid, email: "   " });
    expect(result.success).toBe(false);
  });

  it("does not require @Email format on login — an unknown/malformed email surfaces as InvalidCredentialsError instead", () => {
    const result = loginSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(result.success).toBe(true);
  });

  it("accepts a padded email WITHOUT trimming it — Spring authenticates on the raw string, so a trim here would make a padded login fail even when the account itself was registered with an identical (untrimmed) email", () => {
    const result = loginSchema.safeParse({ ...valid, email: "  mira@example.com  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("  mira@example.com  ");
    }
  });

  it("rejects a missing password", () => {
    const result = loginSchema.safeParse({ ...valid, password: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only password, mirroring @NotBlank", () => {
    const result = loginSchema.safeParse({ ...valid, password: "   " });
    expect(result.success).toBe(false);
  });

  it("imposes no minimum length on login password — unlike registration, only @NotBlank applies", () => {
    const result = loginSchema.safeParse({ ...valid, password: "short" });
    expect(result.success).toBe(true);
  });

  it("accepts a padded password WITHOUT trimming it — the critical account-lockout regression case: a `.trim()` transform here would make login fail for an account registered with a whitespace-padded password, since AuthService.login authenticates against the raw untrimmed string", () => {
    const result = loginSchema.safeParse({ ...valid, password: "  secret12  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.password).toBe("  secret12  ");
    }
  });
});
