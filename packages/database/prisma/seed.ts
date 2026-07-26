/**
 * Seed.
 *
 * Idempotent by design — it upserts, so running it twice is safe and running it
 * against a partly-populated database repairs rather than duplicates. That
 * matters because this same script runs as a Railway release command.
 *
 * M1 seeds accounts only. The eight demo invoices that make the dashboard
 * non-empty arrive at M10, once the extraction pipeline exists to produce
 * realistic extractions for them.
 */
import { hash } from '@node-rs/argon2';
import { MIN_PASSWORD_LENGTH, PASSWORD_HASH_PARAMS, normalizeEmail } from '@invoiceiq/domain';
import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'demo@invoiceiq.dev';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password-123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@invoiceiq.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin-password-123';

async function seedUser(email: string, password: string, role: UserRole) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Seed password for ${email} is ${password.length} chars; minimum is ${MIN_PASSWORD_LENGTH}.`,
    );
  }

  const normalized = normalizeEmail(email);
  const passwordHash = await hash(password, PASSWORD_HASH_PARAMS);

  const user = await prisma.user.upsert({
    where: { email: normalized },
    // Re-seeding rotates the hash rather than leaving a stale one behind, so
    // changing DEMO_PASSWORD in the environment actually takes effect.
    update: { passwordHash, role },
    create: { email: normalized, passwordHash, role },
  });

  return user;
}

async function main() {
  const started = Date.now();

  const demo = await seedUser(DEMO_EMAIL, DEMO_PASSWORD, UserRole.REVIEWER);
  const admin = await seedUser(ADMIN_EMAIL, ADMIN_PASSWORD, UserRole.ADMIN);

  const counts = {
    users: await prisma.user.count(),
    documents: await prisma.document.count(),
  };

  console.log(`Seeded in ${Date.now() - started}ms`);
  console.log(`  reviewer  ${demo.email}  (${demo.id})`);
  console.log(`  admin     ${admin.email}  (${admin.id})`);
  console.log(`  totals    ${counts.users} users, ${counts.documents} documents`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
