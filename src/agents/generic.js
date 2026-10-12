import { EventEmitter } from 'node:events';

import * as tmux from '../tmux.js';

/**
 * 세션 로그 규격이 없는 TUI 에이전트를 위한 대비책 (opencode, aider, gemini ...).
 * 화면이 조용해지면 턴이 끝난 것으로 본다.
 *
 * 화면에는 스피너와 경과 시간이 계속 돌기 때문에 날것으로 비교하면 영원히
 * "변하는 중"이 된다. 숫자와 스피너 글자를 지운 뒤에 비교한다.
 *
 * 정확도는 로그 기반(codex/claude)보다 확실히 낮다. 답변 본문도 "화면에 새로
 * 나타난 줄"로 근사할 뿐이다. 쓸 수 있는 에이전트라면 전용 어댑터가 낫다.
 */

const SPINNER = /[⠀-⣿─-╿✢✳∗·•◐◓◑◒◜◝◞◟⏳⌛]/g;
const DECORATION = /[▀▄█▌▐━─│┃╹╻┏┓┗┛├┤┬┴┼╭╮╰╯▣◆●○◦·⊙⊘▪▫■□]/g;

/** 비교용으로 공백을 전부 지운다. TUI 가 입력을 줄바꿈으로 접어도 맞출 수 있게. */
const squash = (text) => text.replace(/\s+/g, '');

/** 테두리·구분선처럼 글자가 없는 줄. */
const isDecoration = (line) => line.replace(DECORATION, '').trim().length === 0;

const normalize = (screen) =>
  screen
    .replace(SPINNER, '')
    .replace(/\d+/g, '') // 경과 시간·토큰 수가 계속 바뀐다
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();

class PaneIdleWatcher extends EventEmitter {
  #session;
  #pollMs;
  #idleMs;
  #minRunMs;
  #captureLines;
  #timer = null;
  #armed = false;
  #baseline = [];
  #prompt = '';
  #lastNormalized = '';
  #lastChangeAt = 0;
  #startedAt = 0;
  #turnSeq = 0;
  #turnId = null;
  #busy = false;

  constructor({ tmuxSession, pollMs = 1000, idleMs = 6000, minRunMs = 4000, captureLines = 200 }) {
    super();
    this.#session = tmuxSession;
    this.#pollMs = pollMs;
    this.#idleMs = idleMs;
    this.#minRunMs = minRunMs;
    this.#captureLines = captureLines;
  }

  get activeFile() {
    return null; // 로그를 보지 않는다
  }

  async start() {
    this.#timer = setInterval(() => void this.#tick(), this.#pollMs);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * 프롬프트를 보낸 직후 세션이 부른다. 이 시점의 화면을 기준으로 잡고,
   * 여기서부터 조용해질 때까지를 한 턴으로 센다.
   */
  async armTurn(promptText = '') {
    const screen = await this.#capture();
    this.#baseline = screen.split('\n').map((line) => line.trim());
    this.#prompt = promptText;
    this.#lastNormalized = normalize(screen);
    this.#lastChangeAt = Date.now();
    this.#startedAt = Date.now();
    this.#turnId = `pane-${++this.#turnSeq}`;
    this.#armed = true;
    this.emit('turn-started', { turnId: this.#turnId });
  }

  async #capture() {
    try {
      return await tmux.capturePane(this.#session, this.#captureLines);
    } catch {
      return '';
    }
  }

  async #tick() {
    if (!this.#armed || this.#busy) return;
    this.#busy = true;
    try {
      const screen = await this.#capture();
      const current = normalize(screen);
      const now = Date.now();

      if (current !== this.#lastNormalized) {
        this.#lastNormalized = current;
        this.#lastChangeAt = now;
        return;
      }
      if (now - this.#startedAt < this.#minRunMs) return;
      if (now - this.#lastChangeAt < this.#idleMs) return;

      this.#armed = false;
      this.emit('turn-completed', {
        turnId: this.#turnId,
        message: this.#extractNewLines(screen),
        durationMs: now - this.#startedAt,
      });
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.#busy = false;
    }
  }

  /**
   * 답변만 남기려는 시도. 화면에서 내가 보낸 프롬프트를 찾아 그 뒤부터 자르고,
   * 못 찾으면 기준 화면에 없던 줄만 남긴다. 어느 쪽이든 근사치다.
   */
  #extractNewLines(screen) {
    const lines = screen.split('\n').map((line) => line.trimEnd());

    const probe = squash(this.#prompt).slice(0, 12);
    if (probe) {
      const at = lines.findLastIndex((line) => squash(line).includes(probe));
      if (at >= 0) {
        const after = lines.slice(at + 1).filter((line) => !isDecoration(line));
        const text = after.join('\n').trim();
        if (text) return text;
      }
    }

    const before = new Set(this.#baseline);
    const added = lines.filter((line) => line.trim() && !before.has(line.trim()) && !isDecoration(line));
    const text = added.join('\n').trim();
    if (text) return text;

    return lines.slice(-40).join('\n').trim();
  }
}

function createWatcher({ tmuxSession, pollMs, idleMs, minRunMs }) {
  return new PaneIdleWatcher({ tmuxSession, pollMs, idleMs, minRunMs });
}

export const genericAgent = {
  name: 'generic',
  defaultCommand: null, // 라우트에서 반드시 지정해야 한다
  launchArgs: () => [],
  enterDelayMs: 2000,
  // TUI 가 뜨고 입력을 받기까지 codex/claude 보다 오래 걸린다.
  // 짧게 잡으면 첫 프롬프트가 통째로 유실된다.
  settleMs: 8000,
  completion: '화면이 조용해지면 완료 (근사치 — 전용 어댑터가 있으면 그쪽이 낫다)',
  needsArm: true, // 세션이 전송 직후 armTurn() 을 불러줘야 한다
  createWatcher,
};
