import "server-only";
import { z } from "zod";
import { USER_ROLES } from "@/db/schema";

/**
 * Request-body validation for the auth DTOs (replaces the Jakarta Bean
 * Validation annotations on `RegisterRequest`, `LoginRequest` and
 * `NewAdminRequest`).
 *
 * SOURCE:
 * - drone-missions-backend/.../web/dto/auth/RegisterRequest.java
 * - drone-missions-backend/.../web/dto/auth/LoginRequest.java
 * - drone-missions-backend/.../web/dto/user/NewAdminRequest.java
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

/**
 * Mirrors `NewAdminRequest`: `@NotBlank username`, `@NotBlank @Email email`,
 * `@NotBlank @Size(min = 8, message = "password must be at least 8
 * characters") password` — as the source DTO's own comment puts it,
 * "RegisterRequest without a role; it is always ADMIN".
 *
 * The missing `role` is the whole point and must not be added back: the role is
 * fixed by `auth.service.ts`'s `createAdmin`, so a caller cannot mint a
 * DESIGNER/PILOT through the admin-only endpoint, and cannot smuggle an extra
 * field past it either — Zod objects strip unknown keys by default, the way
 * Jackson ignores properties with no record component.
 *
 * Every constraint is expressed exactly as `registerSchema` expresses its
 * identical three, down to the `@NotBlank` check-don't-mutate semantics and the
 * untrimmed `@Size(min = 8)` measurement — see that schema's comments for why
 * neither field is `.trim()`-ed. Deliberately declared as its own object rather
 * than derived from `registerSchema` via `.omit({ role: true })`: the source
 * keeps two independent DTOs, and a derivation would silently propagate a
 * future change to the registration body onto this endpoint.
 */
export const newAdminSchema = z.object({
  username: z
    .string({ error: "username is required" })
    .refine((value) => value.trim().length > 0, "username is required"),
  email: z.email("email must be a well-formed email address"),
  password: z
    .string({ error: "password is required" })
    .min(8, "password must be at least 8 characters")
    .refine((value) => value.trim().length > 0, "password is required"),
});

export type NewAdminInput = z.infer<typeof newAdminSchema>;
