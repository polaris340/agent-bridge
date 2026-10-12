import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveAgent } from './agents/index.js';
import { tmuxNameFor } from './config.js';
import { AgentSession } from './session.js';

test('sonnet 은 모델 인자를 붙여 띄운다', () => {
  const sonnet = resolveAgent('sonnet');
  for (const args of [sonnet.launchArgs('/x', { id: 'a' }, {}), sonnet.resumeArgs('/x', { id: 'a' }, {})]) {
    assert.match(args.join(' '), /--model sonnet/);
    assert.ok(!args.includes('--remote-control'), '기본으로는 Remote Control 을 켜지 않는다');
  }
  assert.doesNotMatch(resolveAgent('claude').resumeArgs('/x', { id: 'a' }, {}).join(' '), /--model/);
});

test('CLAUDE_REMOTE_CONTROL=true 면 --remote-control 을 맨 끝에 둔다', () => {
  process.env.CLAUDE_REMOTE_CONTROL = 'true';
  try {
    for (const name of ['claude', 'sonnet']) {
      const agent = resolveAgent(name);
      assert.equal(agent.launchArgs('/x', { id: 'a' }, {}).at(-1), '--remote-control');
      assert.equal(agent.resumeArgs('/x', { id: 'a' }, {}).at(-1), '--remote-control');
    }
  } finally {
    delete process.env.CLAUDE_REMOTE_CONTROL;
  }
});

test('sonnet 과 claude 는 같은 판 이름을 쓴다', () => {
  const at = { cwd: '/Users/me/workspace/my-web', scopeId: '1234567890123456789' };
  assert.equal(tmuxNameFor({ agent: 'sonnet', ...at }), tmuxNameFor({ agent: 'claude', ...at }));
});

async function sessionWithRecord() {
  const spoolDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sonnet-'));
  const tmuxSession = `bridge-sonnet-test-${process.pid}`;
  const session = new AgentSession({
    key: 'k', agentName: 'claude', cwd: os.tmpdir(), tmuxSession, spoolDir, autoTmuxName: false,
    enterDelayMs: 100, turnStartTimeoutMs: 1000, turnTimeoutMs: 0, pollMs: 1000, rescanMs: 1000, idleMs: 1000,
  });
  const record = path.join(spoolDir, `instance-${tmuxSession}.json`);
  await fsp.writeFile(record, JSON.stringify({ id: 'talked-before', launchedAt: 1 }));
  await session.start();
  return { session, record };
}

test('claude 에서 sonnet 으로 바꾸면 하던 대화를 이어 간다', async () => {
  const { session, record } = await sessionWithRecord();
  try {
    assert.equal(await session.retarget({ agentName: 'sonnet' }), 'kept');
    assert.equal(session.agentName, 'sonnet');
    assert.equal(JSON.parse(await fsp.readFile(record, 'utf8')).id, 'talked-before');
  } finally {
    session.stop(); // 실패해도 감시를 멈춰야 검사가 끝난다
  }
});

test('다른 에이전트로 바꾸면 대화를 새로 시작한다', async () => {
  const { session, record } = await sessionWithRecord();
  try {
    assert.equal(await session.retarget({ agentName: 'codex' }), true);
    await assert.rejects(fsp.access(record));
  } finally {
    session.stop();
  }
});

test('봇이 시킨 일이 아니어도 화면이 일하는 중이면 일하는 중으로 본다', async () => {
  // 봇을 다시 띄우면 그 전에 시킨 일은 봇이 모른다. 이때 바꾸면 돌던 작업이 끊긴다.
  const { session } = await sessionWithRecord();
  const tmux = await import('./tmux.js');
  try {
    await tmux.createSession(session.tmuxSession, os.tmpdir());
    await tmux.sendLiteral(session.tmuxSession, "clear; printf '✻ Working… (esc to interrupt)\\n'; sleep 30");
    await tmux.sendEnter(session.tmuxSession);
    await new Promise((done) => setTimeout(done, 800));
    assert.equal(session.busy, false);
    assert.equal(await session.isWorking(), true);
  } finally {
    session.stop();
    await tmux.killSession(session.tmuxSession).catch(() => {});
  }
});

test('에이전트가 스스로 돌린 턴도 활동으로 쳐서 정리 시계를 다시 감는다', async () => {
  // 30분마다 메일을 확인하는 반복 작업처럼, 사람이 시키지 않은 턴이 끝날 때.
  const { session } = await sessionWithRecord();
  try {
    session.lastUsedAt = 0;
    let delivered = null;
    session.onOrphan = (r) => {
      delivered = r.message;
    };
    session.watcher.emit('turn-completed', { turnId: 'self', message: '아직 안 왔습니다', files: [] });
    assert.equal(delivered, '아직 안 왔습니다');
    assert.ok(session.lastUsedAt > 0);
  } finally {
    session.stop();
  }
});
