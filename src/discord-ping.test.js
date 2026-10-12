import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPayloads } from './connectors/discord.js';

test('최종 답은 답장 대상에게 알림을 건다', () => {
  const [first] = buildPayloads('다 됐어요', [], { ping: true });
  assert.equal(first.allowedMentions.repliedUser, true);
});

test('중간 설명은 아무도 안 울린다', () => {
  const [first] = buildPayloads('> 원인을 찾았어요', []);
  assert.equal(first.allowedMentions.repliedUser, false);
  assert.deepEqual(first.allowedMentions.users, []);
});

test('같이 말한 사람은 멘션하고, 알림은 첫 조각에만 건다', () => {
  const long = 'x'.repeat(4500);
  const payloads = buildPayloads(long, ['/a.png'], { ping: true, mention: ['111'] });
  assert.ok(payloads.length > 1);
  assert.match(payloads[0].content, /^<@111> /);
  assert.deepEqual(payloads[0].allowedMentions.users, ['111']);
  for (const p of payloads.slice(1)) {
    assert.equal(p.allowedMentions.repliedUser, false);
    assert.deepEqual(p.allowedMentions.users, []);
  }
  assert.deepEqual(payloads.at(-1).files, ['/a.png']);
});

test('에이전트가 쓴 @everyone 으로는 아무도 안 울린다', () => {
  const [first] = buildPayloads('@everyone 공지', [], { ping: true });
  assert.deepEqual(first.allowedMentions.parse, []);
});
