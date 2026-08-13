import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.SESSION_SECRET ??= 'test-session-secret';

import { hasSession, safeEqual, sessionValue, verifyPassword, SESSION_COOKIE } from '../lib/http.js';
import { dbStub } from './helpers/stubs.js';

const withPassword = async (password: string) => {
  const hash = await bcrypt.hash(password, 4); // low cost keeps the suite fast
  return { stub: dbStub({ app_settings: [{ key: 'admin_password_hash', value: hash }] }), hash };
};

const reqWithCookie = (value: string) => ({ headers: { cookie: `${SESSION_COOKIE}=${value}` } });

test('safeEqual rejects different lengths without throwing', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('the right password verifies and the wrong one does not', async () => {
  const { stub } = await withPassword('hunter2xy');
  assert.notEqual(await verifyPassword(stub.db, 'hunter2xy'), null);
  assert.equal(await verifyPassword(stub.db, 'hunter2xz'), null);
});

test('no password configured means no login is possible', async () => {
  const stub = dbStub();
  assert.equal(await verifyPassword(stub.db, 'anything'), null);
  assert.equal(await hasSession(reqWithCookie('whatever'), stub.db), false);
});

test('a cookie minted from the stored hash is accepted', async () => {
  const { stub, hash } = await withPassword('hunter2xy');
  assert.equal(await hasSession(reqWithCookie(sessionValue(hash)), stub.db), true);
});

test('a forged or absent cookie is rejected', async () => {
  const { stub } = await withPassword('hunter2xy');
  assert.equal(await hasSession(reqWithCookie('forged'), stub.db), false);
  assert.equal(await hasSession({ headers: {} }, stub.db), false);
});

test('changing the password invalidates existing sessions', async () => {
  const { stub, hash } = await withPassword('hunter2xy');
  const cookie = sessionValue(hash);
  assert.equal(await hasSession(reqWithCookie(cookie), stub.db), true);

  stub.tables.app_settings[0].value = await bcrypt.hash('newpassword', 4);
  assert.equal(await hasSession(reqWithCookie(cookie), stub.db), false);
});
