import "server-only";
import { z } from "zod";
import { USER_ROLES } from "@/db/schema";

/**
 * Registration request validation (replaces the Jakarta Bean Validation
 * annotations on `RegisterRequest`).
 *
 * SOURCE: drone-missions-backend/.../web/dto/auth/RegisterRequest.java
 */

/**
 * Mirrors `RegisterRequest`: `@NotBlank username`, `@NotBlank @Email email`,
 * `@NotBlank @Size(min = 8, message = "password must be at least 8
 * characters") password`, `@NotNull role`. `role` accepts every `UserRole`
 * value including `ADMIN` here, exactly like the Java DTO — the ADMIN
 * self-registration guard is a runtime rule enforced in
 * `auth.service.ts`'s `createUser`, not a schema-level restriction.
 */
export const registerSchema = z.object({
  // `@NotBlank` validates blankness without mutating the value — Spring never
  // trims a submitted username, so this deliberately checks rather than
  // transforms (a `.trim()` here would silently strip whitespace this schema
  // stores verbatim, unlike the source's `user.setUsername(username)`).
  username: z
    .string({ error: "username is required" })
    .refine((value) => value.trim().length > 0, "username is required"),
  email: z.email("email must be a well-formed email address"),
  password: z
    .string({ error: "password is required" })
    .min(8, "password must be at least 8 characters")
    // `@Size(min = 8)` in the source measures the untrimmed value, so this
    // field is deliberately NOT `.trim()`-ed before the length check above —
    // only whitespace-only input (which passes `.min(8)` but is blank once
    // trimmed) is additionally rejected here, mirroring `@NotBlank`.
    .refine((value) => value.trim().length > 0, "password is required"),
  role: z.enum(USER_ROLES, { error: "role is required" }),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Mirrors `LoginRequest`: `@NotBlank email`, `@NotBlank password`. Unlike
 * `registerSchema`, the source puts no `@Email` constraint on the login
 * field — it's just a non-blank string, since an unknown/malformed email is
 * indistinguishable from a wrong password at this layer (both surface as
 * the same `InvalidCredentialsError` from `auth.service.ts`'s `login`).
 */
export const loginSchema = z.object({
  // Both fields mirror `@NotBlank`'s check-don't-mutate semantics (see the
  // comment on `registerSchema.username` above). This matters most for
  // `password`: `AuthService.login` hands the raw string straight to
  // `AuthenticationManager`, which compares it against a BCrypt hash of
  // whatever was submitted at registration verbatim — trimming here would
  // make a padded password fail to authenticate even when it's the exact
  // string that was registered, permanently locking the account out.
  email: z
    .string({ error: "email is required" })
    .refine((value) => value.trim().length > 0, "email is required"),
  password: z
    .string({ error: "password is required" })
    .refine((value) => value.trim().length > 0, "password is required"),
});

export type LoginInput = z.infer<typeof loginSchema>;
