import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentSession } from './session.js';

const session = (command) =>
  new AgentSession({ key: 'k', agentName: 'codex', command, cwd: '/x', tmuxSession: 't', spoolDir: '/x/.spool' });

test('실행 명령에 옵션을 같이 적어도 낱말로 갈라 넘긴다', () => {
  // 통째로 따옴표를 씌우면 셸이 'codex --yolo' 라는 프로그램을 찾는다.
  assert.equal(session('codex --yolo').launchCommand, 'codex --yolo --cd /x');
});

test('경로에 띄어쓰기가 있으면 배열로 적는다', () => {
  assert.equal(session(['/My Tools/codex', '--yolo']).launchCommand, "'/My Tools/codex' --yolo --cd /x");
});
