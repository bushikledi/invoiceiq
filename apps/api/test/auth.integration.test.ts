import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { REFRESH_COOKIE_NAME } from '@invoiceiq/contracts';
import {
  createTestContext,
  destroyTestContext,
  resetDatabase,
  resetThrottler,
  type TestContext,
} from './helpers/test-app.js';

let ctx: TestContext;

const CREDENTIALS = { email: 'reviewer@invoiceiq.dev', password: 'a-sufficiently-long-password' };

/** Pulls the refresh cookie value out of a Set-Cookie header. */
function refreshCookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!cookie) throw new Error('No refresh cookie was set');
  const value = cookie.split(';')[0]?.split('=')[1];
  if (!value) throw new Error('Refresh cookie had no value');
  return value;
}

const api = () => request(ctx.app.getHttpServer());

async function registerUser() {
  const res = await api().post('/api/v1/auth/register').send(CREDENTIALS).expect(201);
  return { res, refreshToken: refreshCookieFrom(res) };
}

beforeAll(async () => {
  ctx = await createTestContext();
}, 180_000);

afterAll(async () => {
  if (ctx) await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  resetThrottler(ctx.app);
});

describe('registration', () => {
  it('creates an account and issues a session', async () => {
    const { res } = await registerUser();

    expect(res.body.user).toMatchObject({ email: CREDENTIALS.email, role: 'REVIEWER' });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);
  });

  it('never returns the password hash', async () => {
    const { res } = await registerUser();
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('sets the refresh token as an httpOnly, SameSite=Strict, path-scoped cookie', async () => {
    const { res } = await registerUser();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;

    // The whole XSS defence rests on these attributes, so they are asserted
    // rather than assumed.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/auth');
  });

  it('rejects a duplicate email with 409', async () => {
    await registerUser();
    const res = await api().post('/api/v1/auth/register').send(CREDENTIALS).expect(409);
    expect(res.body.type).toBe('conflict');
  });

  it('treats email as case-insensitive', async () => {
    await registerUser();
    await api()
      .post('/api/v1/auth/register')
      .send({ ...CREDENTIALS, email: 'REVIEWER@InvoiceIQ.dev' })
      .expect(409);
  });

  it('rejects a short password with a field-level validation error', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'x@y.dev', password: 'short' })
      .expect(422);

    expect(res.body.type).toBe('validation_error');
    expect(res.body.errors).toContainEqual(
      expect.objectContaining({ path: 'password', message: expect.stringContaining('12') }),
    );
  });
});

describe('login', () => {
  beforeEach(registerUser);

  it('succeeds with correct credentials', async () => {
    const res = await api().post('/api/v1/auth/login').send(CREDENTIALS).expect(200);
    expect(res.body.user.email).toBe(CREDENTIALS.email);
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    // Identical responses are what stop an attacker enumerating valid accounts.
    const wrongPassword = await api()
      .post('/api/v1/auth/login')
      .send({ ...CREDENTIALS, password: 'wrong-but-long-enough' })
      .expect(401);

    const unknownUser = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@invoiceiq.dev', password: 'wrong-but-long-enough' })
      .expect(401);

    expect(wrongPassword.body.detail).toBe(unknownUser.body.detail);
    expect(wrongPassword.body.type).toBe(unknownUser.body.type);
  });
});

describe('refresh token rotation', () => {
  it('rotates: the new token works and the old one is burnt', async () => {
    const { refreshToken: first } = await registerUser();

    const rotated = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${first}`)
      .expect(200);

    const second = refreshCookieFrom(rotated);
    expect(second).not.toBe(first);

    // The successor is usable.
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${second}`)
      .expect(200);
  });

  it('rejects a refresh with no cookie', async () => {
    await api().post('/api/v1/auth/refresh').expect(401);
  });

  it('rejects a forged token', async () => {
    await registerUser();
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=not-a-real-token`)
      .expect(401);
  });

  /**
   * THE M3 GATE.
   *
   * Replaying an already-rotated token is proof that two parties hold what
   * should be a single-use secret. The correct response is not to reject that
   * one request — it is to assume theft and destroy the entire family, so the
   * attacker's *and* the victim's tokens all stop working and a fresh login is
   * required.
   */
  it('detects reuse and revokes the ENTIRE token family', async () => {
    const { refreshToken: stolen } = await registerUser();

    // The legitimate user refreshes, burning `stolen` and receiving `current`.
    const rotated = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolen}`)
      .expect(200);
    const current = refreshCookieFrom(rotated);

    // The attacker replays the stolen token. Detected.
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolen}`)
      .expect(401);

    // The critical assertion: the victim's still-unused token is now dead too.
    // Rejecting only the replayed token would leave the attacker's chain alive.
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${current}`)
      .expect(401);

    const live = await ctx.prisma.client.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('clears the cookie when reuse is detected, so the browser stops replaying it', async () => {
    const { refreshToken: stolen } = await registerUser();
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolen}`)
      .expect(200);

    const replay = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolen}`)
      .expect(401);

    const cleared = (replay.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cleared).toContain(`${REFRESH_COOKIE_NAME}=;`);
  });

  it('lets a fresh login start a clean family after a compromise', async () => {
    const { refreshToken: stolen } = await registerUser();
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolen}`)
      .expect(200);
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${stolen}`)
      .expect(401);

    // Revocation must not lock the legitimate user out permanently.
    const relogin = await api().post('/api/v1/auth/login').send(CREDENTIALS).expect(200);
    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshCookieFrom(relogin)}`)
      .expect(200);
  });
});

describe('logout', () => {
  it('revokes the family so the refresh token stops working', async () => {
    const { refreshToken } = await registerUser();

    await api()
      .post('/api/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`)
      .expect(200);

    await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=${refreshToken}`)
      .expect(401);
  });

  it('is a no-op for an unknown token rather than an error', async () => {
    await api()
      .post('/api/v1/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE_NAME}=never-existed`)
      .expect(200);
  });
});

describe('route protection', () => {
  it('leaves health checks public, since probes cannot present a token', async () => {
    await api().get('/api/v1/health/live').expect(200);
    await api().get('/api/v1/health/ready').expect(200);
  });

  it('rejects a protected route with no token', async () => {
    const res = await api().get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.type).toBe('authentication_error');
  });

  it('allows a protected route with a valid token', async () => {
    const { res } = await registerUser();
    const me = await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);

    expect(me.body).toMatchObject({ email: CREDENTIALS.email, role: 'REVIEWER' });
  });

  it('rejects a malformed Authorization header', async () => {
    await api().get('/api/v1/auth/me').set('Authorization', 'Basic abc').expect(401);
    await api().get('/api/v1/auth/me').set('Authorization', 'Bearer').expect(401);
    await api().get('/api/v1/auth/me').set('Authorization', 'abc').expect(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    // Forged with a different key but a structurally valid payload — the
    // signature check is the only thing standing between this and access.
    const forged = jwt.sign(
      { sub: randomUUID(), email: 'x@y.dev', role: 'ADMIN' },
      'wrong-secret',
      {
        algorithm: 'HS256',
        expiresIn: 900,
      },
    );
    await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('rejects the alg:none algorithm-confusion forgery', async () => {
    // The classic JWT attack: strip the signature and claim the token needs no
    // verification. Pinning algorithms to HS256 on verify is what stops it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: randomUUID(), email: 'x@y.dev', role: 'ADMIN' }),
    ).toString('base64url');
    await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${header}.${body}.`)
      .expect(401);
  });
});

describe('rate limiting', () => {
  it('throttles repeated login attempts', async () => {
    await registerUser();
    resetThrottler(ctx.app);

    // The auth bucket allows 10 per minute. Brute-forcing a password is the
    // attack this exists to blunt, so it is asserted rather than assumed.
    const attempts = [];
    for (let i = 0; i < 12; i++) {
      attempts.push(
        await api()
          .post('/api/v1/auth/login')
          .send({ ...CREDENTIALS, password: 'wrong-but-long-enough' }),
      );
    }

    const statuses = attempts.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
  });
});
