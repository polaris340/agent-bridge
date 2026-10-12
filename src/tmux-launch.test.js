import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import * as tmux from './tmux.js';

// 실제 tmux 로 띄워 본다. 가짜로는 "잠깐 셸을 벗어났다가 돌아오는" 순간을 못 만든다.
const available = await tmux.isAvailable().catch(() => false);
const name = (tag) => `bridge-test-${tag}-${process.pid}`;
const opts = { cwd: os.tmpdir(), enterDelayMs: 200, readyTimeoutMs: 8000, settleMs: 2500 };

test('떴다가 곧바로 셸로 돌아가면 뜬 것으로 치지 않는다', { skip: !available && 'tmux 없음' }, async () => {
  // claude --resume 에 없는 대화를 주면 한 줄 찍고 이렇게 끝난다.
  const session = name('dies');
  try {
    await assert.rejects(tmux.ensureAgentRunning(session, { ...opts, launch: 'sleep 1' }), /뜨다 죽었다/);
  } finally {
    await tmux.killSession(session).catch(() => {});
  }
});

test('계속 떠 있으면 뜬 것으로 친다', { skip: !available && 'tmux 없음' }, async () => {
  const session = name('stays');
  try {
    assert.equal(await tmux.ensureAgentRunning(session, { ...opts, launch: 'sleep 30' }), 'session-created');
  } finally {
    await tmux.killSession(session).catch(() => {});
  }
});
