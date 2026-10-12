import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudeturns-'));
process.env.CLAUDE_HOME = home;
const { claudeAgent } = await import('./agents/claude.js');

const user = (text) => ({ type: 'user', message: { content: text } });
const say = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const turnEnd = { type: 'system', subtype: 'turn_duration' };

/** 워처에 기록을 차례로 넣고 내보낸 답을 모은다. 파일 없이 handleRecord 만 쓴다. */
async function replay(records, { idleMs = 60_000 } = {}) {
  const cwd = '/tmp/project-turns';
  const id = `t-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await fsp.writeFile(file, '');
  const watcher = claudeAgent.createWatcher({ cwd, pollMs: 20, rescanMs: 20, idleMs, getInstance: () => ({ id }) });
  const answers = [];
  watcher.on('turn-completed', (r) => answers.push(r.message));
  await watcher.start();
  await fsp.appendFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await new Promise((done) => setTimeout(done, 300));
  watcher.stop();
  return answers;
}

test('답한 직후 다른 메시지가 끼어들어도 그 답은 나간다', async () => {
  // 10-01 실제 순서. 답 → turn_duration → 같은 초에 다른 세션의 메시지.
  const answers = await replay([
    user('[alice] 잘돼가?'),
    say('네, 잘 돌아가고 있어요.'),
    turnEnd,
    user('Another Claude session sent a message: ...'),
  ]);
  assert.deepEqual(answers, ['네, 잘 돌아가고 있어요.']);
});

test('turn_duration 이 없어도 다음 턴이 시작되면 앞 답을 내보낸다', async () => {
  const answers = await replay([user('첫 질문'), say('첫 답'), user('끼어든 메시지')]);
  assert.deepEqual(answers, ['첫 답']);
});

test('turn_duration 을 보면 조용해지길 기다리지 않고 바로 마감한다', async () => {
  // idle 을 60초로 걸어 둬도 300ms 안에 나와야 한다.
  const answers = await replay([user('질문'), say('답'), turnEnd]);
  assert.deepEqual(answers, ['답']);
});

const narration = (text) => ({
  type: 'assistant',
  message: {
    content: [{ type: 'thinking', thinking: text, signature: Buffer.from('\u0012\u0009narration\u0012\u0001x').toString('base64') }],
  },
});
const privateThought = (text) => ({
  type: 'assistant',
  message: { content: [{ type: 'thinking', thinking: text, signature: Buffer.from('opaque').toString('base64') }] },
});
const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: {} }] } };

async function progressOf(records) {
  const cwd = '/tmp/project-turns';
  const id = `p-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await fsp.writeFile(file, '');
  const watcher = claudeAgent.createWatcher({ cwd, pollMs: 20, rescanMs: 20, idleMs: 60_000, getInstance: () => ({ id }) });
  const said = [];
  watcher.on('agent-message', (m) => said.push(m.text));
  await watcher.start();
  await fsp.appendFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await new Promise((done) => setTimeout(done, 300));
  watcher.stop();
  return said;
}

test('thinking 블록에 담긴 중간 설명도 채널로 보낸다', async () => {
  const said = await progressOf([user('고쳐줘'), narration('원인을 두 가지 찾았어요. 지금 고칠게요.'), toolUse]);
  assert.deepEqual(said, ['원인을 두 가지 찾았어요. 지금 고칠게요.']);
});

test('속생각은 내용이 있어도 보내지 않는다', async () => {
  const said = await progressOf([user('고쳐줘'), privateThought('속으로 따져 보면…'), toolUse]);
  assert.deepEqual(said, []);
});

test('턴 도중에 붙어도(재시작 뒤) 그 턴의 답을 내보낸다', async () => {
  // 사람 입력 기록 없이 도구 사용 → 답 → 턴 끝 만 보인다.
  const answers = await replay([toolUse, { type: 'user', message: { content: [{ type: 'tool_result' }] } }, say('커밋할까요?'), turnEnd]);
  assert.deepEqual(answers, ['커밋할까요?']);
});
