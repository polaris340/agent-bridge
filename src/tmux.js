import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tmux(args) {
  const { stdout } = await execFileAsync('tmux', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// tmux 는 대상 이름을 앞글자만 맞아도 매칭한다. '=' 를 붙여 이 세션만 정확히 고른다.
// pane 은 번호로 찍지 않는다. pane-base-index 를 1 로 쓰는 사람이 많아서 '.0' 은 못 찾는다.
// 세션 뒤에 ':' 만 붙이면 그 세션의 지금 창·pane 이다 (봇이 만든 세션은 pane 이 하나뿐이다).
const sessionTarget = (session) => `=${session}`;
const paneTarget = (session) => `=${session}:`;

export async function isAvailable() {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

export async function sessionExists(session) {
  try {
    await tmux(['has-session', '-t', sessionTarget(session)]);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(session, cwd) {
  await tmux(['new-session', '-d', '-s', session, '-c', cwd]);
}

export async function killSession(session) {
  await tmux(['kill-session', '-t', sessionTarget(session)]);
}

/** 첫 pane 에서 지금 돌고 있는 프로그램 이름 (codex / zsh / bash ...). */
export async function paneCommand(session) {
  const out = await tmux(['list-panes', '-t', sessionTarget(session), '-F', '#{pane_current_command}']);
  return out.split('\n')[0]?.trim() ?? '';
}

export async function capturePane(session, lines = 60) {
  return tmux(['capture-pane', '-p', '-t', paneTarget(session), '-S', `-${lines}`]);
}

export async function sendLiteral(session, text) {
  await tmux(['send-keys', '-t', paneTarget(session), '-l', '--', text]);
}

export async function sendEnter(session) {
  await tmux(['send-keys', '-t', paneTarget(session), 'Enter']);
}

/** 진행 중인 작업 중단. codex TUI 는 Esc 로 턴을 끊는다. */
export async function sendEscape(session) {
  await tmux(['send-keys', '-t', paneTarget(session), 'Escape']);
}

/** 키 이름 하나를 그대로 보낸다 (Enter, Escape, C-c ...). */
export async function sendKey(session, key) {
  await tmux(['send-keys', '-t', paneTarget(session), key]);
}

/** 비교용으로 공백을 전부 지운다. TUI 가 입력을 줄바꿈으로 접어도 맞출 수 있게. */
const squash = (text) => text.replace(/\s+/g, '');

/** 화면에 이 텍스트가 나타날 때까지 기다린다. 나타나면 true. */
export async function waitForPaneContains(session, needle, timeoutMs, intervalMs = 400) {
  const target = squash(needle);
  if (!target) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let screen = '';
    try {
      screen = await capturePane(session, 40);
    } catch {
      /* 세션이 아직 안 잡혔을 수 있다 */
    }
    if (squash(screen).includes(target)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** 화면이 이 모양이 될 때까지 기다린다. 됐으면 true. */
export async function waitForPaneMatch(session, pattern, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let screen = '';
    try {
      screen = await capturePane(session, 40);
    } catch {
      /* 세션이 아직 안 잡혔을 수 있다 */
    }
    if (pattern.test(screen)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * 텍스트를 입력창에 넣고 Enter 로 확정한다.
 *
 * 두 군데서 조용히 실패한다.
 *  - TUI 가 막 떴을 때는 입력을 아예 못 받는다. 붙여넣은 게 화면에 보이는지
 *    확인하고, 안 보이면 한 번 더 친다 (안 들어갔으니 중복될 게 없다).
 *  - 붙여넣기 직후 Enter 는 TUI 가 입력을 소화하는 중이라 씹힌다.
 *    텍스트 → 대기 → Enter 순서를 지킨다.
 */
export async function typeAndSubmit(session, text, enterDelayMs, { verify = true } = {}) {
  await sendLiteral(session, text);

  if (verify) {
    const probe = text.slice(0, 12);
    if (!(await waitForPaneContains(session, probe, 4000))) {
      await sendLiteral(session, text);
      await waitForPaneContains(session, probe, 4000);
    }
  }

  await sleep(enterDelayMs);
  await sendEnter(session);
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'tcsh', 'ksh', 'dash', 'login']);

/**
 * pane 에 떠 있는 게 셸인지. 에이전트 실행 여부를 이걸로 판정한다 —
 * 프로그램 이름은 에이전트마다 제각각이고(claude 는 node 로 뜨기도 한다)
 * "셸이 아니면 뭔가 돌고 있다" 가 훨씬 잘 맞는다.
 */
export const isShellCommand = (command) => SHELLS.has((command ?? '').trim().toLowerCase());

/**
 * pane 에 에이전트가 떠 있게 만든다. 세션이 없으면 만들고, 셸만 있으면 띄운다.
 * @param {string} session
 * @param {{cwd:string, launch:string, enterDelayMs:number, readyTimeoutMs?:number, settleMs?:number}} opts
 * @returns {Promise<'already-running'|'started'|'session-created'>}
 */
export async function ensureAgentRunning(
  session,
  { cwd, launch, enterDelayMs, readyTimeoutMs = 40_000, settleMs = 3000, fdLimit = 8192 },
) {
  let outcome = 'started';

  if (!(await sessionExists(session))) {
    await createSession(session, cwd);
    outcome = 'session-created';
    await sleep(1000); // 셸 프롬프트가 뜰 때까지
  } else if (!isShellCommand(await paneCommand(session))) {
    return 'already-running';
  }

  // macOS 기본 파일 디스크립터 한도는 256 이고 tmux 안의 프로세스가 그걸 물려받는다.
  // 파일이 많은 프로젝트에서는 에이전트가 그 한도에 걸려 아예 못 뜬다
  // ("low max file descriptors"). 띄우기 전에 올려 둔다. 못 올려도 그냥 진행한다.
  const withLimit = `ulimit -n ${fdLimit} 2>/dev/null; ${launch}`;

  // 셸에 명령을 치는 것뿐이라 입력창 확인은 필요 없다.
  await typeAndSubmit(session, withLimit, Math.min(enterDelayMs, 1000), { verify: false });
  await waitForAgent(session, readyTimeoutMs);
  // TUI 가 화면을 그리고 입력을 받기 시작할 여유
  await sleep(settleMs);

  // 떴다가 곧바로 죽는 경우가 있다. 이어 붙일 대화가 없으면 claude 는 한 줄 찍고 셸로
  // 돌아간다. 잠깐이라도 셸을 벗어나면 뜬 걸로 쳤더니, 그 뒤로 채널에 쓴 글이 셸에
  // 명령으로 들어갔다("zsh: command not found: 살았냐"). 기다린 뒤에 한 번 더 본다.
  if (isShellCommand(await paneCommand(session).catch(() => ''))) {
    const screen = await capturePane(session, 12).catch(() => '');
    const why = screen.trimEnd().split('\n').filter(Boolean).slice(-3).join(' / ');
    throw new Error(`에이전트가 뜨다 죽었다: ${why.slice(-200)}`);
  }
  return outcome;
}

/** 띄우자마자 죽었을 때 셸에 남는 흔적. 이게 보이면 기다릴 것 없이 실패로 본다. */
const LAUNCH_FAILED = /error:|command not found|No such file or directory|possibly due to|No conversation found/i;

/** pane 이 셸에서 벗어날 때까지 (= 에이전트가 뜰 때까지) 기다린다. */
export async function waitForAgent(session, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let current = '';
    try {
      current = await paneCommand(session);
    } catch {
      /* 세션이 아직 안 잡혔을 수 있다 */
    }
    if (current && !isShellCommand(current)) return current;

    // 셸로 돌아왔는데 에러가 찍혀 있으면 뜨다 죽은 것이다. 끝까지 기다리지 않는다.
    if (isShellCommand(current)) {
      const screen = await capturePane(session, 12).catch(() => '');
      if (LAUNCH_FAILED.test(screen)) {
        const why = screen.trimEnd().split('\n').filter(Boolean).slice(-3).join(' / ');
        throw new Error(`에이전트가 뜨다 죽었다: ${why.slice(-200)}`);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `tmux pane 에 에이전트가 ${Math.round(timeoutMs / 1000)}초 안에 뜨지 않았다 ` +
          `(지금 떠 있는 것: ${current || '없음'})`,
      );
    }
    await sleep(intervalMs);
  }
}
