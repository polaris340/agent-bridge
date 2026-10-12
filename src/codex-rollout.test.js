import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimRollout,
  codexAgent,
  filesFrom,
  forgetClaims,
  locateRollout,
  rolloutTakenByOther,
} from './agents/codex.js';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexhome-'));
process.env.CODEX_HOME = home;

const cwd = '/tmp/project-a';
const day = path.join(home, 'sessions', '2026', '09', '09');
await fsp.mkdir(day, { recursive: true });

/** 실제 rollout 처럼 첫 줄에 session_meta 가 있는 파일을 만든다. */
async function rollout(id, { startedAt, cwd: dir = cwd, touchedAt, extra = {} }) {
  const file = path.join(day, `rollout-2026-09-09T00-00-00-${id}.jsonl`);
  const meta = {
    type: 'session_meta',
    payload: { session_id: id, id, cwd: dir, timestamp: new Date(startedAt).toISOString(), ...extra },
  };
  await fsp.writeFile(file, `${JSON.stringify(meta)}\n`);
  const at = new Date(touchedAt ?? startedAt);
  await fsp.utimes(file, at, at);
  return file;
}

const 어제 = Date.parse('2026-09-08T00:00:00Z');
const 방금 = Date.parse('2026-09-09T10:00:00Z');

// 남이 오래전에 띄워 두고 계속 쓰는 세션. 최근에 움직여서 mtime 이 가장 새롭다.
await rollout('old-and-busy', { startedAt: 어제, touchedAt: 방금 + 60_000 });
await rollout('mine', { startedAt: 방금 });

test('띄운 시각보다 앞선 세션은 물지 않는다', async () => {
  const got = await locateRollout(cwd, { after: 방금 });
  assert.equal(got.sessionId, 'mine');
});

test('시각을 안 주면 가장 최근에 움직인 것을 문다 — 그래서 호출하는 쪽이 시각을 줘야 한다', async () => {
  const got = await locateRollout(cwd, { after: 0 });
  assert.equal(got.sessionId, 'old-and-busy');
});

test('다른 tmux 가 잡고 있는 세션은 건너뛴다', async () => {
  forgetClaims();
  claimRollout('mine', 'codex-my-game');
  assert.equal(await locateRollout(cwd, { after: 방금, taken: (id) => rolloutTakenByOther(id, 'codex-my-game-3780') }), null);
  // 잡은 본인은 그대로 쓴다.
  const own = await locateRollout(cwd, { after: 방금, taken: (id) => rolloutTakenByOther(id, 'codex-my-game') });
  assert.equal(own.sessionId, 'mine');
  forgetClaims();
});

test('폴더가 다르면 보지 않는다', async () => {
  assert.equal(await locateRollout('/tmp/project-b', { after: 0 }), null);
});

/** 워처를 잠깐 돌려 본다. locate 는 감춰져 있어 남는 기록으로 확인한다. */
async function attachedFile(instance, dir = cwd) {
  forgetClaims();
  const watcher = codexAgent.createWatcher({
    cwd: dir,
    tmuxSession: 'codex-project-a',
    pollMs: 30,
    rescanMs: 30,
    getInstance: () => instance,
    updateInstance: async (patch) => Object.assign(instance, patch),
  });
  let file = null;
  watcher.on('file-switched', (event) => {
    file = event.file;
  });
  watcher.on('error', () => {});
  await watcher.start();
  await new Promise((done) => setTimeout(done, 200));
  watcher.stop();
  return file;
}

test('띄운 시각을 모르면 아무 세션에도 붙지 않는다', () => {
  // 폴더를 바꾸면(retarget) 기록이 비는데, 그때 남이 쓰던 세션을 물어 두 채널이 섞였다.
  const instance = {};
  return attachedFile(instance).then((file) => {
    assert.equal(file, null);
    assert.equal(instance.codexSessionId, undefined);
  });
});

test('띄운 시각을 알면 그 뒤에 시작된 세션을 자기 것으로 적는다', async () => {
  const instance = { launchedAt: 방금 };
  await attachedFile(instance);
  assert.equal(instance.codexSessionId, 'mine');
});

test('codex 가 만든 그림은 CODEX_HOME 아래에 떨어진다', () => {
  assert.deepEqual(codexAgent.mediaRoots(), [path.join(home, 'generated_images')]);
});

// 이어 붙이기 검사는 따로 폴더를 쓴다. 위 폴더에는 갓 시작한 세션이 있어서
// 폴더 검색이 먼저 걸린다.
const 이어붙인폴더 = '/tmp/project-resumed';
await rollout('kept-writing', { cwd: 이어붙인폴더, startedAt: 어제, touchedAt: 방금 + 60_000 });
await rollout('gone-quiet', { cwd: 이어붙인폴더, startedAt: 어제, touchedAt: 어제 });

test('이어 붙인 세션이 원래 파일에 계속 쓰면 그 파일을 되찾는다', async () => {
  // codex resume 은 대개 새 파일을 만들지 않는다. 시작 시각이 띄운 시각보다 앞서
  // 폴더 검색으로는 못 찾는다 — 걸었던 id 로 집어야 답을 받는다.
  const instance = { launchedAt: 방금, resumedFrom: 'kept-writing' };
  await attachedFile(instance, 이어붙인폴더);
  assert.equal(instance.codexSessionId, 'kept-writing');
});

test('이어 붙인 파일이 띄운 뒤로 조용하면 붙지 않는다', async () => {
  const instance = { launchedAt: 방금, resumedFrom: 'gone-quiet' };
  await attachedFile(instance, 이어붙인폴더);
  assert.equal(instance.codexSessionId, undefined);
});

test('이어 붙이는 중이라 id 가 비어 있어도 그 대화로 다시 붙는다', () => {
  // 이어 붙이면 codexSessionId 가 잠깐 비는데, 그 사이에 한 번 더 띄우면
  // 빈 기록만 보고 새 대화를 시작해 버렸다. social-media 채널이 그렇게 날아갔다.
  const args = codexAgent.resumeArgs('/tmp/project-a', { resumedFrom: 'kept-writing' });
  assert.deepEqual(args, ['resume', 'kept-writing', '--cd', '/tmp/project-a']);
});

test('걸 곳이 아무것도 없으면 새로 시작한다', () => {
  assert.equal(codexAgent.resumeArgs('/tmp/project-a', {}), null);
});

test('내장 그림 도구로 만든 것은 올린다', () => {
  const made = `file://${home}/generated_images/01a095d1/exec-f4e518da.png`;
  assert.deepEqual(filesFrom(made ? { type: 'ImageView', path: made } : null), [
    `${home}/generated_images/01a095d1/exec-f4e518da.png`,
  ]);
});

test('작업 폴더에서 열어 본 그림은 올리지 않는다', () => {
  // 결과를 확인하려고 턴마다 다시 여는 것이라, 올리면 같은 그림이 도배된다.
  assert.deepEqual(filesFrom({ type: 'ImageView', path: '/Users/me/workspace/my-app/beauty.png' }), []);
  assert.deepEqual(filesFrom({ type: 'FileChange', changes: { 'shot.png': {} } }), []);
});

test('경로의 퍼센트 인코딩을 푼다', () => {
  const made = `file://${home}/generated_images/s1/%EA%B7%B8%EB%A6%BC%20one.png`;
  assert.deepEqual(filesFrom({ type: 'ImageView', path: made }), [`${home}/generated_images/s1/그림 one.png`]);
});

test('이어 띄울 때 함께 생기는 승인 검토 대화에는 붙지 않는다', async () => {
  // 10-05: 본 대화를 이어 띄우자 guardian 검토 대화가 같은 폴더에 새로 생겼고,
  // 시각으로 찾다가 그쪽에 먼저 붙었다.
  const dir = '/tmp/project-guardian';
  const started = 방금 + 3_600_000;
  await rollout('main-thread', { cwd: dir, startedAt: started, extra: { thread_source: 'user', source: 'cli' } });
  await rollout('guardian-side', {
    cwd: dir,
    startedAt: started + 1000,
    touchedAt: started + 60_000,
    extra: { session_id: 'main-thread', parent_thread_id: 'main-thread', thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } },
  });
  const got = await locateRollout(dir, { after: started });
  assert.equal(got.sessionId, 'main-thread');
  assert.match(got.file, /main-thread\.jsonl$/);
});
