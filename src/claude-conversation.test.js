import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudehome-'));
process.env.CLAUDE_HOME = home;

const { claudeAgent } = await import('./agents/claude.js');

const cwd = '/tmp/project-claude';
const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
await fsp.mkdir(dir, { recursive: true });
await fsp.writeFile(path.join(dir, 'talked.jsonl'), '{"type":"user"}\n');

test('말을 건 적이 있는 대화는 이어 붙일 수 있다', async () => {
  assert.equal(await claudeAgent.hasConversation(cwd, { id: 'talked' }), true);
});

test('띄워 놓기만 하고 말을 안 건 대화는 이어 붙일 게 없다', async () => {
  // claude 는 첫 메시지 전엔 파일을 안 만든다. 그 id 로 --resume 하면 곧바로 죽는다.
  assert.equal(await claudeAgent.hasConversation(cwd, { id: 'never-started' }), false);
});

test('기록에 id 가 없으면 이어 붙일 게 없다', async () => {
  assert.equal(await claudeAgent.hasConversation(cwd, {}), false);
});
