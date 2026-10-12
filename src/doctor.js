import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';

import { config, configProblems, sessionOptions } from './config.js';
import { connectorNames } from './connectors/index.js';
import { AgentSession } from './session.js';
import * as tmux from './tmux.js';

const execFileAsync = promisify(execFile);

let failed = false;
const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failed = true;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
};
const warn = (label, detail = '') => console.log(`  ⚠️  ${label}${detail ? ` — ${detail}` : ''}`);

console.log('\n== 설정 ==');
const problems = configProblems();
if (problems.length === 0) ok('설정', `커넥터 ${config.connector} / 라우트 ${config.routes.length}개`);
else for (const problem of problems) bad('설정', problem);
if (!connectorNames.includes(config.connector)) {
  bad('커넥터', `'${config.connector}' 는 없다. 있는 것: ${connectorNames.join(', ')}`);
}

console.log('\n== tmux ==');
if (await tmux.isAvailable()) {
  const { stdout } = await execFileAsync('tmux', ['-V']);
  ok('tmux', stdout.trim());
} else {
  bad('tmux', '설치돼 있지 않다 (brew install tmux)');
}

for (const route of config.routes) {
  console.log(`\n== 라우트 ${route.key} ==`);

  let session;
  try {
    session = new AgentSession(sessionOptions(route));
  } catch (err) {
    bad('라우트', err.message);
    continue;
  }

  ok('에이전트', `${session.agentName} — ${session.agent.completion}`);
  if (route.channelIds.length > 0) ok('채널', route.channelIds.join(', '));
  else warn('채널', '이 라우트엔 채널 지정이 없다. 전역 허용 목록을 따른다.');

  try {
    const { stdout } = await execFileAsync(session.command, ['--version']);
    ok('실행 파일', `${stdout.trim().split('\n')[0]} (${session.command})`);
  } catch (err) {
    // --version 을 지원하지 않는 CLI 도 있다. 실행 자체가 되는지만 본다.
    try {
      await fsp.access(session.command);
      warn('실행 파일', `${session.command} — --version 이 안 먹는다 (${err.code ?? err.message})`);
    } catch {
      bad('실행 파일', `${session.command} 을 찾을 수 없다. command 를 실경로로 지정해라.`);
    }
  }

  try {
    const st = await fsp.stat(session.cwd);
    if (st.isDirectory()) ok('작업 폴더', session.cwd);
    else bad('작업 폴더', `폴더가 아니다: ${session.cwd}`);
  } catch {
    bad('작업 폴더', `없는 경로다: ${session.cwd}`);
  }

  if (await tmux.sessionExists(session.tmuxSession)) {
    const running = await tmux.paneCommand(session.tmuxSession);
    if (tmux.isShellCommand(running)) warn(`tmux ${session.tmuxSession}`, `셸(${running})만 떠 있다. 첫 메시지에서 띄운다.`);
    else ok(`tmux ${session.tmuxSession}`, `${running} 실행 중`);
  } else {
    warn(`tmux ${session.tmuxSession}`, '아직 없다. 첫 메시지에서 만든다.');
  }

  // 로그 기반 어댑터는 실제 파일에서 턴이 뽑히는지까지 확인한다.
  // "파일이 있다" 로는 파싱이 깨진 걸 잡을 수 없다.
  if (!session.agent.inspect) {
    warn('완료 감지', '화면 idle 방식이라 미리 점검할 로그가 없다. selftest 로 확인해라.');
    continue;
  }
  try {
    const found = await session.agent.inspect(session.cwd);
    if (!found) {
      warn('완료 감지', `${session.cwd} 에서 돈 세션 기록이 아직 없다. 첫 턴 뒤에 잡힌다.`);
    } else if (found.turns === 0) {
      warn('완료 감지', `${found.file} 에 완료된 턴이 없다 (방금 연 세션이면 정상)`);
    } else {
      const preview = (found.lastMessage ?? '').replace(/\s+/g, ' ').slice(0, 50);
      ok('완료 감지', `${found.turns}턴 파싱, 마지막 답변: "${preview}${preview.length >= 50 ? '…' : ''}"`);
      if (!found.lastMessage) bad('답변 추출', '마지막 답변 본문이 비었다 — 로그 포맷이 바뀌었을 수 있다');
    }
  } catch (err) {
    bad('완료 감지', `로그 파싱 실패: ${err.message}`);
  }
}

console.log(failed ? '\n문제가 있다. 위 ❌ 를 먼저 고쳐라.\n' : '\n이상 없다.\n');
process.exit(failed ? 1 : 0);
