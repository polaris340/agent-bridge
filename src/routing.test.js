import assert from 'node:assert/strict';
import test from 'node:test';

import { pickRoute, sessionKey } from './routing.js';

const route = (over = {}) => ({
  key: 'codex:my-game',
  channelIds: [],
  userIds: [],
  perThread: true,
  perChannel: true,
  ...over,
});

const conf = (routes, over = {}) => ({
  routes,
  allowedChannelIds: [],
  allowedGuildIds: [],
  allowedUserIds: [],
  ...over,
});

const keyOf = (got) => (got ? sessionKey(got.route, got.scopeId) : null);

test('채널을 콕 집은 라우트는 그 라우트의 고정 세션을 쓴다', () => {
  const r = route({ channelIds: ['111'] });
  const got = pickRoute(conf([r]), { channelId: '111' });
  assert.equal(got.route, r);
  assert.equal(got.scopeId, null);
  assert.equal(keyOf(got), 'codex:my-game');
});

test('허용하지 않은 채널은 막힌다', () => {
  const r = route({ channelIds: ['111'] });
  assert.equal(pickRoute(conf([r]), { channelId: '999', guildId: 'g1' }), null);
});

test('스레드는 부모 채널의 라우트를 물려받고 자기 세션을 쓴다', () => {
  const r = route({ channelIds: ['111'] });
  const got = pickRoute(conf([r]), { channelId: '222', parentId: '111' });
  assert.equal(got.route, r);
  assert.equal(keyOf(got), 'codex:my-game#222');
});

test('같은 채널의 서로 다른 스레드는 서로 다른 세션이 된다', () => {
  const r = route({ channelIds: ['111'] });
  const a = pickRoute(conf([r]), { channelId: '222', parentId: '111' });
  const b = pickRoute(conf([r]), { channelId: '333', parentId: '111' });
  assert.notEqual(keyOf(a), keyOf(b));
});

test('perThread:false 면 스레드도 부모 채널 세션을 함께 쓴다', () => {
  const r = route({ channelIds: ['111'], perThread: false });
  const got = pickRoute(conf([r]), { channelId: '222', parentId: '111' });
  assert.equal(keyOf(got), 'codex:my-game');
});

test('서버가 허용되면 등록하지 않은 채널도 쓸 수 있다', () => {
  const open = route({ channelIds: [] });
  const c = conf([open], { allowedGuildIds: ['g1'] });
  assert.ok(pickRoute(c, { channelId: '777', guildId: 'g1' }));
  assert.equal(pickRoute(c, { channelId: '777', guildId: 'g2' }), null);
});

test('서버 안의 채널들은 채널마다 세션이 갈린다', () => {
  const open = route({ channelIds: [] });
  const c = conf([open], { allowedGuildIds: ['g1'] });
  const a = pickRoute(c, { channelId: '777', guildId: 'g1' });
  const b = pickRoute(c, { channelId: '888', guildId: 'g1' });
  assert.equal(keyOf(a), 'codex:my-game#777');
  assert.equal(keyOf(b), 'codex:my-game#888');
  assert.notEqual(keyOf(a), keyOf(b));
});

test('perChannel:false 면 서버 안 채널들이 한 세션을 함께 쓴다', () => {
  const open = route({ channelIds: [], perChannel: false });
  const c = conf([open], { allowedGuildIds: ['g1'] });
  const a = pickRoute(c, { channelId: '777', guildId: 'g1' });
  const b = pickRoute(c, { channelId: '888', guildId: 'g1' });
  assert.equal(keyOf(a), 'codex:my-game');
  assert.equal(keyOf(b), 'codex:my-game');
});

test('등록한 채널은 서버 전체 허용과 무관하게 고정 세션을 지킨다', () => {
  const pinned = route({ key: 'codex:my-game', channelIds: ['111'] });
  const open = route({ key: 'codex:workspace', channelIds: [] });
  const c = conf([pinned, open], { allowedGuildIds: ['g1'] });
  assert.equal(keyOf(pickRoute(c, { channelId: '111', guildId: 'g1' })), 'codex:my-game');
  assert.equal(keyOf(pickRoute(c, { channelId: '999', guildId: 'g1' })), 'codex:workspace#999');
});

test('허용한 사람만 부를 수 있다', () => {
  const open = route({ channelIds: [] });
  const c = conf([open], { allowedGuildIds: ['g1'], allowedUserIds: ['u1'] });
  assert.ok(pickRoute(c, { channelId: '777', guildId: 'g1', userId: 'u1' }));
  assert.equal(pickRoute(c, { channelId: '777', guildId: 'g1', userId: 'u2' }), null);
});

test('사람 제한은 등록한 채널에도 걸린다', () => {
  const r = route({ channelIds: ['111'] });
  const c = conf([r], { allowedUserIds: ['u1'] });
  assert.ok(pickRoute(c, { channelId: '111', userId: 'u1' }));
  assert.equal(pickRoute(c, { channelId: '111', userId: 'u2' }), null);
});

test('DM 은 서버가 없어도 채널 허용 목록에 있으면 쓸 수 있다', () => {
  const open = route({ channelIds: [] });
  const c = conf([open], { allowedChannelIds: ['dm1'], allowedGuildIds: ['g1'] });
  assert.ok(pickRoute(c, { channelId: 'dm1', guildId: null }));
  assert.equal(pickRoute(c, { channelId: 'dm2', guildId: null }), null);
});

test('맞는 라우트가 없으면 null', () => {
  assert.equal(pickRoute(conf([]), { channelId: '111' }), null);
});

test('장소도 사람도 안 적힌 열린 라우트는 아무도 못 쓴다', () => {
  // 다른 라우트에 채널을 적었다고 채널 없는 라우트까지 서버 아무나·DM 에 열리면 안 된다.
  const pinned = route({ key: 'codex:pinned', channelIds: ['111'] });
  const open = route({ key: 'claude:open' });
  const c = conf([pinned, open]);
  assert.equal(pickRoute(c, { channelId: '999', guildId: 'g9', userId: 'stranger' }), null);
  assert.equal(pickRoute(c, { channelId: 'dm', userId: 'stranger' }), null);
  assert.equal(keyOf(pickRoute(c, { channelId: '111', userId: 'anyone' })), 'codex:pinned');
});

test('사람 목록만 있으면 열린 라우트는 그 사람들에게만 열린다', () => {
  const c = conf([route({ key: 'claude:open' })], { allowedUserIds: ['u1'] });
  assert.ok(pickRoute(c, { channelId: 'dm', userId: 'u1' }));
  assert.equal(pickRoute(c, { channelId: 'dm', userId: 'u2' }), null);
});
