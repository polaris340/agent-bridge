import fsp from 'node:fs/promises';
import path from 'node:path';

import { config, sessionOptions, tmuxNameFor } from './config.js';
import { pickRoute, sessionKey } from './routing.js';
import { AgentSession } from './session.js';
import * as tmux from './tmux.js';

/**
 * 채널·스레드를 세션(= 에이전트 인스턴스)에 붙인다.
 *
 * 메시지를 붙잡아 두지 않는다. 에이전트가 작업 중에 들어온 입력을 알아서
 * 반영하므로(steering), 큐에 세우는 대신 그대로 밀어 넣는 게 맞다.
 *
 * 채널과 스레드는 보통 작업 하나의 단위라 각자 세션을 따로 띄운다. 이렇게 만들어진
 * 세션은 조용해지면 알아서 닫는다 — 안 그러면 채널을 열 때마다 tmux 세션과 에이전트
 * 프로세스가 쌓이기만 한다.
 */
export class Router {
  #sessions = new Map(); // key → AgentSession
  #scopeChoice = new Map(); // scopeId → { cwd, agent } (채널이 골라 둔 것)
  #sweepTimer = null;
  #onSessionClosed;
  #onSessionReady;

  constructor(routes, { onSessionClosed, onSessionReady } = {}) {
    this.routes = routes;
    this.#onSessionClosed = onSessionClosed;
    this.#onSessionReady = onSessionReady;
  }

  get sessions() {
    return [...this.#sessions.values()];
  }

  get #scopeChoiceFile() {
    return path.join(config.spoolDir, 'channel-projects.json');
  }

  async start() {
    await this.#loadScopeChoice();
    for (const route of this.routes) {
      const session = new AgentSession(sessionOptions(route));
      this.#sessions.set(route.key, session);
      await session.start();
      this.#onSessionReady?.(session);
    }
    await this.#rehydrate();
    this.#sweepTimer = setInterval(() => void this.#sweep(), config.sweepMs);
  }

  stop() {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
    for (const session of this.#sessions.values()) session.stop();
  }

  async #loadScopeChoice() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.#scopeChoiceFile, 'utf8'));
      for (const [scopeId, value] of Object.entries(raw)) {
        // 예전에는 폴더만 문자열로 적었다.
        this.#scopeChoice.set(scopeId, typeof value === 'string' ? { cwd: value } : value);
      }
    } catch {
      /* 없으면 처음 도는 것이다 */
    }
  }

  /**
   * 채널이 고른 폴더와 에이전트를 적어둔다. 세션이 idle 로 닫혔다 다시 떠도
   * 그대로 뜬다. 이게 없으면 채널마다 매번 다시 골라야 한다.
   */
  async remember(scopeId, patch) {
    if (!scopeId) return;
    this.#scopeChoice.set(scopeId, { ...(this.#scopeChoice.get(scopeId) ?? {}), ...patch });
    await fsp.mkdir(config.spoolDir, { recursive: true });
    await fsp.writeFile(
      this.#scopeChoiceFile,
      JSON.stringify(Object.fromEntries(this.#scopeChoice), null, 1),
      'utf8',
    );
  }

  /**
   * 이 채널·스레드·사람이 쓸 세션. 못 쓰면 null.
   * 채널·스레드용 세션은 여기서 처음 만들어진다.
   */
  async resolve({ channelId, parentId, guildId, userId }) {
    const picked = pickRoute(
      {
        routes: this.routes,
        allowedChannelIds: config.allowedChannelIds,
        allowedGuildIds: config.allowedGuildIds,
        allowedUserIds: config.allowedUserIds,
      },
      { channelId, parentId, guildId, userId },
    );
    if (!picked) return null;
    return this.#sessionFor(picked.route, picked.scopeId, String(channelId));
  }

  async #sessionFor(route, scopeId, channelId) {
    const key = sessionKey(route, scopeId);

    let session = this.#sessions.get(key);
    if (!session) {
      // 그 채널이 전에 골라 둔 폴더·에이전트가 있으면 그대로 띄운다.
      const choice = this.#scopeChoice.get(scopeId) ?? {};
      const cwd = choice.cwd ?? route.cwd;
      const agent = choice.agent ?? route.agent;
      session = new AgentSession({
        ...sessionOptions(route),
        key,
        cwd,
        agentName: agent,
        command: agent === route.agent ? route.command : undefined,
        tmuxSession: tmuxNameFor({ agent, cwd, scopeId }),
        dynamic: true,
        autoTmuxName: true,
        scopeId,
        channelId,
      });
      this.#sessions.set(key, session);
      await session.start();
      this.#onSessionReady?.(session);
      console.log(`[route] 세션 생성 ${key} → ${session.cwd} (tmux ${session.tmuxSession})`);
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  /**
   * 봇이 꺼져 있는 동안에도 에이전트는 하던 일을 계속한다. 그 사이에 끝난 작업의
   * 답을 채널로 보내려면 누군가 로그를 보고 있어야 한다. 그래서 시작할 때, 판이
   * 살아 있는 채널에는 말을 걸지 않아도 미리 붙는다.
   */
  async #rehydrate() {
    const open = this.routes.find((r) => r.channelIds.length === 0);
    if (!open) return;

    for (const [scopeId, choice] of this.#scopeChoice) {
      const agent = choice.agent ?? open.agent;
      const cwd = choice.cwd ?? open.cwd;
      const name = tmuxNameFor({ agent, cwd, scopeId });
      if (!(await tmux.sessionExists(name))) continue;
      if (this.#sessions.has(sessionKey(open, scopeId))) continue;
      try {
        await this.#sessionFor(open, scopeId, scopeId);
        console.log(`[route] 돌고 있던 판에 다시 붙었다 (tmux ${name})`);
      } catch (err) {
        console.error(`[route] ${name} 에 다시 붙지 못했다: ${err.message}`);
      }
    }
  }

  /** 조용해진 채널·스레드 세션을 닫는다. 일하는 중이면 건드리지 않는다. */
  async #sweep() {
    const now = Date.now();
    for (const [key, session] of [...this.#sessions]) {
      if (!session.isDynamic || session.busy) continue;
      if (now - session.lastUsedAt < config.threadIdleMs) continue;
      // 봇이 모르는 일을 하고 있을 수 있다(봇 재시작 전에 시킨 일, 스스로 돌리는 턴).
      // 내리기 직전에 화면까지 보고, 일하는 중이면 시계를 다시 감는다.
      if (await session.isWorking()) {
        session.lastUsedAt = now;
        continue;
      }

      this.#sessions.delete(key);
      try {
        // 기록은 남긴다. 다시 부르면 하던 얘기를 이어서 띄운다.
        await session.park();
        console.log(`[route] 세션 정리 ${key} (대화는 남겨 둔다)`);
        await this.#onSessionClosed?.(session);
      } catch (err) {
        console.error(`[route] ${key} 정리 실패: ${err.message}`);
      }
    }
  }
}
