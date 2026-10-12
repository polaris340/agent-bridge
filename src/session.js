import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { resolveAgent } from './agents/index.js';
import { tmuxNameFor } from './config.js';
import * as tmux from './tmux.js';

/** 이벤트 하나를 타임아웃과 함께 기다린다. */
export function waitFor(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`'${event}' 를 ${Math.round(timeoutMs / 1000)}초 동안 못 받았다`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    emitter.once(event, onEvent);
  });
}

const shellQuote = (value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

/**
 * 실행 명령을 낱말로 가른다. "codex --yolo" 처럼 옵션을 같이 적어도 되게 한다.
 * 통째로 따옴표를 씌우면 셸이 'codex --yolo' 라는 이름의 프로그램을 찾는다.
 * 경로에 띄어쓰기가 있으면 배열로 적는다: ["/My Tools/codex", "--yolo"]
 */
const commandWords = (command) => (Array.isArray(command) ? command : String(command).trim().split(/\s+/));

/**
 * 에이전트를 처음 띄울 때 앞을 가로막는 화면들.
 *
 * codex 도 claude 도 처음 여는 폴더에서는 신뢰 여부를 먼저 묻는다. 여기 걸린 걸
 * 모르고 프롬프트를 밀어 넣으면 그 지시는 통째로 유실되고, 봇은 영문도 모른 채
 * "시작 신호가 없다" 로 타임아웃 난다. 실제로 새 폴더를 붙이자마자 이걸 겪었다.
 *
 * 열 수 있는 폴더는 운영자가 .env 에 적어둔 것뿐이므로 신뢰 확인은 넘겨도 된다.
 * 다만 조용히 넘기지 않고 로그에 남긴다.
 */
const STARTUP_PROMPTS = [{ pattern: /Do you trust/i, keys: ['Enter'], label: '폴더 신뢰 확인' }];

/**
 * tmux 세션 하나 = 에이전트 인스턴스 하나.
 * 어느 에이전트든 "띄우고 / 프롬프트 넣고 / 턴이 끝날 때까지 기다리는" 절차는 같고,
 * 완료를 어떻게 아는지만 어댑터가 정한다.
 */
export class AgentSession {
  #agent;
  #watcher = null;
  #options;
  #instance = null;
  #inflight = 0;
  #sendQueue = Promise.resolve();
  #pending = [];
  busy = false;
  /** 아무도 기다리지 않는 완료(타임아웃 뒤 늦게 끝난 작업)를 받아갈 자리. */
  onOrphan = null;
  /** 작업 도중 에이전트가 낸 중간 설명을 받아갈 자리. */
  onProgress = null;
  /** 사람이 골라줘야 넘어가는 화면에 걸렸을 때 알릴 자리. */
  onBlocked = null;
  /** 대화가 너무 커서 이어 붙이지 못했을 때 알릴 자리. */
  onResumeSkipped = null;
  /** 마지막으로 일을 시킨 시각. 스레드 세션을 언제 닫을지 판단하는 기준. */
  lastUsedAt = Date.now();

  constructor(options) {
    this.#options = options;
    this.#agent = resolveAgent(options.agentName);
    if (!this.command) {
      throw new Error(`라우트 '${options.key}': 에이전트 '${options.agentName}' 의 실행 명령을 정할 수 없다. command 를 지정해라.`);
    }
  }

  get key() {
    return this.#options.key;
  }
  get agentName() {
    return this.#agent.name;
  }
  get agent() {
    return this.#agent;
  }
  get cwd() {
    return this.#options.cwd;
  }
  get tmuxSession() {
    return this.#options.tmuxSession;
  }
  get command() {
    return this.#options.command || this.#agent.defaultCommand;
  }
  get watcher() {
    return this.#watcher;
  }

  /** 이 에이전트가 만든 그림을 따로 두는 자리. 작업 폴더 밖이라도 올려 준다. */
  get mediaRoots() {
    return this.#agent.mediaRoots?.() ?? [];
  }

  /** 스레드 때문에 그때그때 만들어진 세션인지. 이런 것만 idle 로 닫는다. */
  get isDynamic() {
    return Boolean(this.#options.dynamic);
  }

  /** 이 세션이 매인 채널·스레드 id. 닫힐 때 그쪽에 알리려고 들고 있는다. */
  get channelId() {
    return this.#options.channelId ?? null;
  }

  /** 세션을 가른 단위(채널·스레드 id). 고른 폴더를 기억할 때 열쇠로 쓴다. */
  get scopeId() {
    return this.#options.scopeId ?? null;
  }

  launchCommandFor(instance) {
    const args = this.#agent.launchArgs?.(this.cwd, instance, { tmuxSession: this.tmuxSession }) ?? [];
    return [...commandWords(this.command), ...args].map(shellQuote).join(' ');
  }

  /** 표시용. 아직 안 띄웠으면 세션 id 자리는 실행할 때 정해진다. */
  get launchCommand() {
    return this.launchCommandFor(this.#instance ?? { id: '(실행할 때 생성)', launchedAt: 0 });
  }

  /**
   * 이 tmux 세션에서 도는 에이전트 인스턴스의 식별자.
   *
   * 같은 폴더에서 사람이 직접 돌리는 세션과 로그가 섞이는 걸 막는 장치다.
   * claude 는 ~/.claude/projects/<폴더>/ 에 세션 파일이 수십 개씩 쌓여서
   * "가장 최근 파일" 로 고르면 남의 세션을 읽는다. 봇이 UUID 를 정해 띄우고
   * 그 파일만 본다. codex 는 세션 id 를 지정할 수 없어 띄운 시각으로 거른다.
   *
   * 봇을 재시작해도 tmux 안의 에이전트는 살아 있으므로 디스크에 남겨 이어 쓴다.
   */
  get #instanceFile() {
    return path.join(this.#options.spoolDir, `instance-${this.tmuxSession}.json`);
  }

  async #loadInstance() {
    try {
      return JSON.parse(await fsp.readFile(this.#instanceFile, 'utf8'));
    } catch {
      return null;
    }
  }

  async #saveInstance(instance) {
    await fsp.mkdir(this.#options.spoolDir, { recursive: true });
    await fsp.writeFile(this.#instanceFile, JSON.stringify(instance), 'utf8');
  }

  get enterDelayMs() {
    return this.#options.enterDelayMs ?? this.#agent.enterDelayMs ?? 2000;
  }

  async start() {
    this.#instance = await this.#loadInstance();
    this.#watcher = this.#agent.createWatcher({
      cwd: this.cwd,
      tmuxSession: this.tmuxSession,
      // 에이전트를 다시 띄우면 인스턴스가 바뀐다. 값이 아니라 조회 함수를 넘긴다.
      getInstance: () => this.#instance,
      // 어댑터가 뒤늦게 알아낸 식별자(codex 세션 id 등)를 붙여둔다.
      updateInstance: async (patch) => {
        this.#instance = { ...(this.#instance ?? {}), ...patch };
        await this.#saveInstance(this.#instance);
      },
      pollMs: this.#options.pollMs,
      rescanMs: this.#options.rescanMs,
      idleMs: this.#options.idleMs,
    });
    this.#watcher.on('error', (err) => console.error(`[${this.tmuxSession}] watcher: ${err.message}`));
    this.#watcher.on('file-switched', ({ file }) => console.log(`[${this.tmuxSession}] 세션 파일 → ${file}`));
    this.#watcher.on('turn-completed', (result) => this.#settle(result));
    this.#watcher.on('agent-message', (payload) => this.onProgress?.(payload));
    await this.#watcher.start();
  }

  stop() {
    this.#watcher?.stop();
  }

  /**
   * tmux 만 내리고 대화 기록은 남긴다. 다음에 부르면 그 대화를 이어서 띄운다.
   * 조용해졌다고 해서 하던 얘기까지 버릴 이유는 없다.
   */
  async park() {
    this.stop();
    try {
      if (await tmux.sessionExists(this.tmuxSession)) await tmux.killSession(this.tmuxSession);
    } catch {
      /* 이미 없으면 그만이다 */
    }
  }

  /** 아예 접는다. 이어 붙일 기록까지 버린다 (폴더를 옮기거나 !restart 할 때). */
  async close() {
    await this.park();
    await fsp.rm(this.#instanceFile, { force: true }).catch(() => {});
  }

  /**
   * 이 세션을 다른 폴더로 옮긴다. 에이전트는 실행할 때 작업 폴더가 정해지므로
   * 옮기려면 새로 띄우는 수밖에 없다. 이전 대화 맥락은 남지 않는다.
   * @returns {Promise<boolean>} 실제로 옮겼으면 true (같은 폴더면 false)
   */
  async retarget({ cwd, agentName }) {
    const next = cwd ? path.resolve(cwd) : this.cwd;
    const nextAgent = agentName ?? this.#options.agentName;
    if (next === this.cwd && nextAgent === this.#options.agentName) return false;

    // 에이전트가 바뀌면 실행 명령도 그 에이전트 것으로 다시 정해야 한다.
    // 라우트에 적힌 command 는 원래 에이전트용이라 그대로 쓰면 엉뚱한 걸 띄운다.
    const agentChanged = nextAgent !== this.#options.agentName;
    const nextAdapter = agentChanged ? resolveAgent(nextAgent) : this.#agent;
    // 폴더는 그대로고 같은 대화를 쓰는 변형(claude ↔ sonnet)이면 대화를 이어 간다.
    // 판만 내려서 다음 메시지에 새 인자로 이어 붙인다.
    const keepConversation =
      next === this.cwd && agentChanged && Boolean(this.#agent.family) && this.#agent.family === nextAdapter.family;

    if (keepConversation) {
      await this.park();
      this.#agent = nextAdapter;
      this.#options = { ...this.#options, agentName: nextAgent, command: undefined };
      await this.start();
      return 'kept';
    }

    await this.close();
    if (agentChanged) this.#agent = nextAdapter;

    // 이름에 에이전트와 폴더가 들어가므로 옮기면 이름도 따라가야 한다.
    const tmuxSession = this.#options.autoTmuxName
      ? tmuxNameFor({ agent: nextAgent, cwd: next, scopeId: this.scopeId })
      : this.#options.tmuxSession;
    this.#options = {
      ...this.#options,
      cwd: next,
      agentName: nextAgent,
      command: agentChanged ? undefined : this.#options.command,
      tmuxSession,
    };
    this.#instance = null;
    // 그 이름으로 예전에 쓰던 기록이 남아 있으면 엉뚱한 대화를 이어 붙이려 든다.
    await fsp.rm(this.#instanceFile, { force: true }).catch(() => {});
    await this.start();
    return true;
  }

  /**
   * 사람이 쓴 글은 에이전트에게만 넣는다. 판에 셸이 떠 있으면 그 글이 명령으로
   * 실행된다 — 한 번은 "살았냐" 가 zsh 에 들어갔다. 글에 따라서는 파일을 지울 수도
   * 있으니, 보내기 직전에 한 번 더 보고 셸이면 보내지 않는다.
   */
  async #assertAgentInPane() {
    const current = await tmux.paneCommand(this.tmuxSession).catch(() => '');
    if (current && !tmux.isShellCommand(current)) return;
    throw new Error(
      `${this.agentName} 이 떠 있지 않아서 보내지 않았다 (판에는 ${current || '아무것도 없다'}). ` +
        '다시 말을 걸면 새로 띄운다.',
    );
  }

  /**
   * tmux 로 키를 보내는 구간은 겹치면 안 된다. 겹치면 두 지시가 입력창에서 섞여
   * 한 줄로 이어붙는다 (봇을 두 개 띄웠을 때 겪은 것과 같은 증상이다).
   * 완료를 기다리는 건 겹쳐도 되므로 전송만 한 줄로 세운다.
   */
  async #sendExclusive(fn) {
    const previous = this.#sendQueue;
    let done;
    this.#sendQueue = new Promise((resolve) => {
      done = resolve;
    });
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      done();
    }
  }

  /**
   * 이 턴의 결과를 기다릴 자리를 잡는다.
   *
   * 답을 기다리는 사이에 메시지를 더 보내면 에이전트는 그것들을 같은 턴에 반영한다.
   * 그때 각 요청에 결과를 그대로 돌려주면 똑같은 답장이 보낸 횟수만큼 나간다.
   * 그래서 한 턴에 묶인 요청 중 마지막 하나만 대표(primary)로 삼는다.
   */
  #awaitCompletion() {
    const ticket = {};
    const limit = this.#options.turnTimeoutMs ?? 0;
    const promise = new Promise((resolve, reject) => {
      ticket.resolve = resolve;
      // 0 이면 제한 없이 기다린다. 에이전트가 아직 일하고 있는데 실패로 만들 이유가 없다.
      if (limit > 0) {
        ticket.timer = setTimeout(() => {
          this.#pending = this.#pending.filter((t) => t !== ticket);
          reject(new Error(`턴이 ${Math.round(limit / 1000)}초 안에 끝나지 않았다`));
        }, limit);
      }
    });
    this.#pending.push(ticket);
    return promise;
  }

  /** 완료 이벤트 하나로, 지금 답을 기다리는 요청들을 한꺼번에 해소한다. */
  #settle(result) {
    const group = this.#pending;
    this.#pending = [];
    if (group.length === 0) {
      // 타임아웃이 난 뒤에도 에이전트는 계속 일한다. 그 결과가 여기로 온다.
      // 버리면 20분 넘는 작업은 영영 답을 못 받는다.
      console.log(`[${this.key}] 기다리는 요청이 없는 완료 이벤트 (늦게 끝난 작업)`);
      // 사람이 시키지 않은 턴도 살아서 일하는 것이다(스스로 30분마다 확인하는 반복 작업 등).
      // 이걸 활동으로 안 치면 사람이 6시간 말을 안 건 사이에 판이 내려가 반복이 끊긴다.
      this.lastUsedAt = Date.now();
      this.onOrphan?.(result);
      return;
    }
    group.forEach((ticket, index) => {
      clearTimeout(ticket.timer);
      ticket.resolve({ ...result, primary: index === group.length - 1 });
    });
  }

  /**
   * 사람이 골라줘야 넘어가는 화면에 걸렸는지 본다.
   * 여기 걸리면 넣은 프롬프트가 그 창에 먹혀서 아무 일도 일어나지 않는다.
   * 조용히 멈춰 있으면 아무도 모르므로 화면을 그대로 넘겨 알린다.
   */
  async #looksBlocked() {
    const pattern = this.#agent.blockedPattern;
    if (!pattern) return null;
    try {
      const screen = await tmux.capturePane(this.tmuxSession, 0);
      return pattern.test(screen) ? screen.trimEnd().split('\n').slice(-14).join('\n') : null;
    } catch {
      return null;
    }
  }

  /**
   * 지금 일하는 중인지. 봇이 보낸 요청만 세면 모자란다 — 봇을 다시 띄운 뒤에는 그 전에
   * 시킨 일이 안 잡히고, 다른 세션이 보낸 메시지로 돌아가는 턴도 있다. 화면도 같이 본다.
   */
  async isWorking() {
    return this.busy || (await this.#looksBusy());
  }

  async #looksBusy() {
    const pattern = this.#agent.busyPattern;
    if (!pattern) return false;
    try {
      // 스크롤백에 남은 옛 화면에 걸리지 않게 지금 보이는 것만 본다.
      return pattern.test(await tmux.capturePane(this.tmuxSession, 0));
    } catch {
      return false;
    }
  }

  /** 신뢰 확인 같은 시작 화면을 넘긴다. */
  async #clearStartupPrompts(log) {
    const prompts = this.#agent.startupPrompts ?? STARTUP_PROMPTS;
    let previous = null;

    // 확인 화면이 여러 단계로 이어지기도 한다. 실제로 세 단계를 넘겨야 했다.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let screen = '';
      try {
        // 스크롤백까지 보면 이미 넘긴 화면이 위쪽에 남아 계속 걸린다. 그러면
        // 넘어간 뒤에도 Enter 를 계속 쳐서 입력창에 빈 줄이 들어간다.
        // 지금 눈에 보이는 화면만 본다.
        screen = await tmux.capturePane(this.tmuxSession, 0);
      } catch {
        return;
      }
      const hit = prompts.find((prompt) => prompt.pattern.test(screen));
      if (!hit) return;

      // 눌러도 화면이 그대로면 우리가 넘길 수 있는 화면이 아니다. 더 치지 않는다.
      if (screen === previous) {
        log('시작 화면이 그대로다. 더 누르지 않는다. `!pane` 으로 확인해라.');
        return;
      }
      previous = screen;

      log(`시작 화면을 넘긴다: ${hit.label}`);
      const keys = hit.keysFor ? hit.keysFor(screen) : hit.keys;
      for (const key of keys) await tmux.sendKey(this.tmuxSession, key);
      await tmux.sleep(2500);
    }
    log('시작 화면이 계속 남아 있다. `!pane` 으로 화면을 확인해라.');
  }

  async ensureRunning({ log = () => {} } = {}) {
    const exists = await tmux.sessionExists(this.tmuxSession);
    if (exists && !tmux.isShellCommand(await tmux.paneCommand(this.tmuxSession))) {
      // 이미 돌고 있다. 그 인스턴스를 이어 쓴다 (봇만 재시작된 경우 포함).
      this.#instance ??= await this.#loadInstance();
      return 'already-running';
    }

    // 전에 나누던 대화가 있으면 그걸 이어서 띄운다.
    const previous = this.#instance ?? (await this.#loadInstance());
    let resumeArgs = previous
      ? this.#agent.resumeArgs?.(this.cwd, previous, { tmuxSession: this.tmuxSession })
      : null;

    // 적어 둔 id 는 있는데 대화가 한 번도 시작되지 않았으면 이어 붙일 게 없다.
    // 없는 대화를 이어 붙이려다 죽고 "이어 붙이지 못했다" 고 알리는 대신 조용히 새로 띄운다.
    if (resumeArgs && this.#agent.hasConversation && !(await this.#agent.hasConversation(this.cwd, previous))) {
      log('적어 둔 대화가 시작된 적이 없다 (첫 메시지가 안 들어간 채 끝났다). 새로 띄운다.');
      resumeArgs = null;
    }

    if (resumeArgs) {
      const instance = this.#agent.onResume?.(previous) ?? { ...previous, launchedAt: Date.now() };
      try {
        const state = await this.#launch(instance, resumeArgs, log);
        log('전에 나누던 대화를 이어서 띄웠다');
        return state;
      } catch (err) {
        // 기록이 사라졌거나, 대화가 너무 불어나 열다가 죽었을 수 있다.
        // 크기로 미리 막지 않는다. 되는 크기를 짐작할 근거가 없어서, 해 보고
        // 안 되면 새로 시작한다.
        log(`이어서 띄우지 못했다 (${err.message}). 새로 시작한다.`);
        this.onResumeSkipped?.(err.message);
      }
    }

    return this.#launch({ id: randomUUID(), launchedAt: Date.now() }, null, log);
  }

  /** 실제로 띄우고, 입력을 받을 수 있는 상태가 될 때까지 손봐 준다. */
  async #launch(instance, resumeArgs, log) {
    this.#instance = instance;
    await this.#saveInstance(instance);

    const launch = resumeArgs
      ? [...commandWords(this.command), ...resumeArgs].map(shellQuote).join(' ')
      : this.launchCommandFor(instance);

    const state = await tmux.ensureAgentRunning(this.tmuxSession, {
      cwd: this.cwd,
      launch,
      enterDelayMs: this.enterDelayMs,
      // TUI 는 뜬 직후 잠깐 입력을 못 받는다. 이때 보낸 프롬프트는 통째로 유실된다.
      settleMs: this.#agent.settleMs ?? 3000,
    });

    await this.#clearStartupPrompts(log);

    // 고정 시간만 기다리면 느리게 뜨는 TUI 에서 첫 지시가 통째로 유실된다.
    // 입력창이 실제로 그려진 걸 보고 나서 보낸다.
    if (this.#agent.readyPattern) {
      const ready = await tmux.waitForPaneMatch(this.tmuxSession, this.#agent.readyPattern, 60_000);
      log(ready ? `${this.agentName} 입력창이 준비됐다` : '입력창 신호를 못 봤다. 그대로 진행한다.');
    }

    return state;
  }

  /**
   * 줄바꿈이 섞였거나 긴 프롬프트는 파일로 넘긴다.
   * tmux 로 줄바꿈을 그대로 붙여넣으면 TUI 가 중간에서 Enter 로 받아 지시가 토막 난다.
   */
  async #preparePrompt(text) {
    const limit = this.#options.inlinePromptMaxChars ?? 700;
    if (!/[\r\n]/.test(text) && text.length <= limit) return text;

    const dir = this.#options.spoolDir;
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `prompt-${Date.now()}.md`);
    await fsp.writeFile(file, text, 'utf8');
    return `채팅으로 받은 지시다. 아래 파일을 읽고 그 내용대로 처리해라: ${file}`;
  }

  async snapshot(lines = 30) {
    try {
      const pane = await tmux.capturePane(this.tmuxSession, lines);
      return pane.trimEnd().split('\n').slice(-lines).join('\n').slice(-1200);
    } catch (err) {
      return `(화면을 못 읽었다: ${err.message})`;
    }
  }

  async interrupt() {
    await tmux.sendEscape(this.tmuxSession);
  }

  /** 하던 얘기를 버리고 처음부터 다시 띄운다. */
  async restart() {
    await this.close();
    this.#instance = null;
    await this.start();
    return this.ensureRunning();
  }

  async status() {
    const exists = await tmux.sessionExists(this.tmuxSession);
    const running = exists ? await tmux.paneCommand(this.tmuxSession) : null;
    return {
      key: this.key,
      agent: this.agentName,
      cwd: this.cwd,
      tmuxSession: this.tmuxSession,
      sessionExists: exists,
      paneCommand: running,
      agentRunning: Boolean(running) && !tmux.isShellCommand(running),
      watchingFile: this.#watcher?.activeFile ?? null,
      busy: this.busy,
    };
  }

  /**
   * 프롬프트를 넣고 그 턴이 끝날 때까지 기다린다.
   * @returns {Promise<{turnId:string|null, message:string, durationMs:number|null}>}
   */
  async runTurn(text, { log = () => {} } = {}) {
    if (!this.#watcher) throw new Error('세션이 아직 start() 되지 않았다');

    // 이미 뭔가 돌고 있으면 새 턴을 여는 게 아니라 그 턴에 끼어드는 것이다.
    // 봇이 재시작되면 #inflight 는 0 이지만 에이전트는 계속 일하고 있을 수 있다.
    // 그때 새 턴을 기다리면 앞 작업이 끝날 때까지 영문 모르고 실패한다.
    const steering = this.#inflight > 0 || (await this.#looksBusy());
    this.#inflight += 1;
    this.busy = true;
    this.lastUsedAt = Date.now();

    try {
      const state = await this.ensureRunning({ log });
      if (state !== 'already-running') log(`${this.agentName} 을 새로 띄웠다 (${state})`);

      const payload = await this.#preparePrompt(text);

      // 전송 전에 자리를 잡아둔다. 턴이 순식간에 끝나도 놓치지 않게.
      const completed = this.#awaitCompletion();

      if (steering) {
        // 에이전트가 작업 중에 들어온 입력을 알아서 반영한다. 그대로 밀어 넣는다.
        // 이때는 새 turn_started 가 안 뜰 수 있으므로 Enter 재전송을 하지 않는다.
        // 재전송했다가는 같은 지시가 두 번 들어간다.
        log('작업 중이라 그대로 밀어 넣는다');
        await this.#sendExclusive(async () => {
          await this.#assertAgentInPane();
          await tmux.typeAndSubmit(this.tmuxSession, payload, this.enterDelayMs);
        });
        return await completed;
      }

      const started = waitFor(this.#watcher, 'turn-started', this.#options.turnStartTimeoutMs);
      started.catch(() => {});

      await this.#sendExclusive(async () => {
        await this.#assertAgentInPane();
        await tmux.typeAndSubmit(this.tmuxSession, payload, this.enterDelayMs);
        // 화면 idle 방식은 보낸 직후의 화면을 기준으로 삼아야 한다.
        if (this.#agent.needsArm) await this.#watcher.armTurn(payload);
      });

      let sawStart = true;
      try {
        await started;
      } catch {
        // Enter 가 씹혀 프롬프트가 입력창에 남아 있는 흔한 경우다. 한 번만 더 친다.
        log('시작 신호가 없다. Enter 재전송.');
        const retry = waitFor(this.#watcher, 'turn-started', 45_000);
        retry.catch(() => {});
        await this.#sendExclusive(() => tmux.sendEnter(this.tmuxSession));
        try {
          await retry;
        } catch {
          // 그래도 안 보이면 여기서 실패로 끝내지 않는다. 앞 작업이 길어서 아직
          // 차례가 안 왔을 뿐일 수 있다. 넣은 건 화면으로 확인했으니 답을 기다린다.
          sawStart = false;
          log('시작 신호를 못 봤지만 답을 기다린다 (앞 작업이 길 수 있다)');
          const blocked = await this.#looksBlocked();
          if (blocked) {
            log('사람이 골라줘야 넘어가는 화면에 걸려 있다');
            this.onBlocked?.(blocked);
          }
        }
      }

      // 시작 신호를 못 봤는데 "시작했다" 고 찍으면 로그가 거짓말을 한다. 실제로 그 줄을
      // 믿고 claude 가 메시지를 받았다고 읽을 뻔했다.
      if (sawStart) log(`${this.agentName} 이 턴을 시작했다. 완료를 기다린다.`);
      return await completed;
    } finally {
      this.#inflight -= 1;
      this.busy = this.#inflight > 0;
      // 긴 작업이 끝난 직후부터 idle 을 다시 센다. 시작 시각만 쓰면
      // 20분짜리 턴을 돌린 세션이 끝나자마자 닫힐 수 있다.
      this.lastUsedAt = Date.now();
    }
  }
}
