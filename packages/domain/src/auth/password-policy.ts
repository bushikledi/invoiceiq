/**
 * Password hashing policy.
 *
 * The *parameters* are a domain decision (how much work an attacker must do per
 * guess); the *implementation* is infrastructure. Keeping the numbers here means
 * the API's auth service and the seed script cannot drift apart and silently
 * produce hashes of differing strength.
 *
 * argon2id, not bcrypt: bcrypt is compute-hard but memory-cheap, so a GPU or
 * ASIC farm parallelises it efficiently. argon2id is memory-hard, which makes
 * that hardware advantage far more expensive. These values follow current OWASP
 * guidance (19 MiB, t=2, p=1).
 */
export const PASSWORD_HASH_PARAMS = {
  /** 19 MiB, expressed in KiB as the argon2 API expects. */
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Minimum length. Deliberately a length floor rather than a composition rule:
 * NIST dropped mandatory character-class requirements because they push users
 * toward predictable substitutions without adding real entropy.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Normalises an email for storage and lookup: the column is plain TEXT with a
 * unique index, so case-insensitivity is enforced here rather than by CITEXT. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
