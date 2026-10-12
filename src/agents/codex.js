import os from 'node:os';
import path from 'node:path';

import { JsonlTailWatcher, findFiles, readFirstLine, readJsonlRecords } from '../watchers/jsonl-tail.js';

/**
 * codex 는 TUI 세션도 $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl 에 기록하고,
 * 그 안에 턴 경계가 명시적으로 들어 있다.
 *   task_started  — 턴 시작 (= Enter 가 먹었다)
 *   task_complete — 턴 종료 + last_agent_message 에 답변 전문
 * 셋 중 완료 감지가 가장 정확한 에이전트다. 추측이 전혀 없다.
 */

const home = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));

async function sessionMeta(file) {
  try {
    const line = await readFirstLine(file);
    if (!line) return null;
    const parsed = JSON.parse(line);
    return parsed?.type === 'session_meta' ? (parsed.payload ?? null) : null;
  } catch {
    return null;
  }
}

/** 승인 검토 같은 보조 대화인지. 사람이 시키는 본 대화가 아니다. */
export function isSideThread(meta) {
  if (!meta) return false;
  if (meta.parent_thread_id) return true;
  if (meta.thread_source && meta.thread_source !== 'user') return true;
  if (meta.source && typeof meta.source === 'object' && meta.source.subagent) return true;
  return Boolean(meta.id && meta.session_id && meta.id !== meta.session_id);
}

/**
 * 주어진 cwd 에서 돌고 있는 가장 최근 rollout 파일.
 *
 * codex 는 세션 id 를 지정할 수 없어서, 같은 폴더에서 사람이 직접 돌리는 codex 와
 * 로그가 섞일 수 있다. 봇이 에이전트를 띄운 시각(after) 이후에 시작된 세션만 봐서
 * 남의 세션을 읽지 않게 한다.
 */
export async function locateRollout(cwd, { limit = 12, after = 0, taken = () => false } = {}) {
  const candidates = await findFiles(
    path.join(home(), 'sessions'),
    (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
  );
  for (const candidate of candidates.slice(0, limit)) {
    const meta = await sessionMeta(candidate.file);
    if (!meta) continue;
    if (cwd && path.resolve(meta.cwd ?? '') !== path.resolve(cwd)) continue;
    if (after) {
      const startedAt = Date.parse(meta.timestamp ?? '');
      // 시계 오차를 감안해 5초 여유를 둔다.
      if (Number.isFinite(startedAt) && startedAt < after - 5000) continue;
    }
    // 승인 검토(guardian) 같은 보조 대화도 같은 폴더에 rollout 을 남긴다. 본 대화를 이어
    // 띄우면 이게 함께 생겨서, 시각으로 찾으면 본 대화보다 먼저 걸린다(10-05).
    // 보조 대화는 parent_thread_id 가 있고, session_id 가 부모를 가리켜 자기 id 와 다르다.
    if (isSideThread(meta)) continue;
    const sessionId = meta.id ?? meta.session_id ?? null;
    // 다른 채널이 이미 붙잡고 있는 세션은 건너뛴다.
    if (sessionId && taken(sessionId)) continue;
    return { ...candidate, sessionId };
  }
  return null;
}

/** 완결된 rollout 에서 턴 목록을 뽑는다. doctor 의 파서 점검용. */
export async function parseTurns(file) {
  const records = await readJsonlRecords(file);
  return records
    .filter((r) => r?.type === 'event_msg' && r.payload?.type === 'task_complete')
    .map((r) => ({
      turnId: r.payload.turn_id ?? null,
      message: r.payload.last_agent_message ?? '',
      durationMs: r.payload.duration_ms ?? null,
      at: r.timestamp ?? null,
    }));
}

/**
 * 세션 id 로 rollout 파일을 직접 집는다. 파일명이 rollout-<시각>-<uuid>.jsonl 이다.
 * codex 는 새 세션의 id 를 지정할 수 없어서, 봇이 처음 잡은 id 를 기억했다가
 * 그 뒤로는 이 경로로만 본다 (claude 의 --session-id 와 같은 효과).
 */
export async function locateRolloutById(sessionId) {
  const files = await findFiles(
    path.join(home(), 'sessions'),
    (name) => name.startsWith('rollout-') && name.endsWith(`${sessionId}.jsonl`),
  );
  return files[0] ?? null;
}

/**
 * 어느 rollout 을 어느 tmux 세션이 붙잡고 있는지.
 *
 * codex 는 새 세션의 id 를 지정할 수 없어서, 같은 폴더에서 돌면 로그만 보고는
 * 누구 것인지 알 수 없다. 실제로 채널 둘이 같은 세션을 물어 답이 서로 엇갈렸다.
 * 한 번 잡은 세션은 그 tmux 것으로 못 박는다.
 */
const claimedBy = new Map();

export function claimRollout(sessionId, owner) {
  if (sessionId && owner) claimedBy.set(sessionId, owner);
}

export function rolloutTakenByOther(sessionId, owner) {
  const holder = claimedBy.get(sessionId);
  return holder !== undefined && holder !== owner;
}

/** 검사용 — 장부를 비운다. */
export function forgetClaims() {
  claimedBy.clear();
}

/** doctor 용 — 실제 로그에서 턴이 뽑히는지 확인한다. */
async function inspect(cwd) {
  const target = await locateRollout(cwd);
  if (!target) return null;
  const turns = await parseTurns(target.file);
  return { file: target.file, turns: turns.length, lastMessage: turns.at(-1)?.message ?? '' };
}

/**
 * codex 는 파일을 사람에게 보내는 도구가 없다. 원칙은 답변 본문에 적힌 경로만 보고
 * 올리는 것이다.
 *
 * 한때는 로그의 ImageView(열어 본 그림)·FileChange(고친 파일)도 같이 올렸다. 그런데
 * codex 는 자기가 만든 것을 확인하려고 같은 그림을 턴마다 다시 연다. 실측한 한
 * 세션에서 같은 렌더 결과가 네 턴에 걸쳐 네 번 올라갔고 붙여 준 참고 이미지까지
 * 되돌아왔다. 작업 폴더에서 "열어봤다" 는 "보여주려 한다" 가 아니다.
 *
 * 딱 한 자리만 예외다. 내장 그림 도구로 만든 것은 generated_images 아래 떨어지는데,
 * codex 는 그걸 열어서 자기 화면에 띄우고 본문에는 경로를 안 쓴다. 한 세션에서
 * "완성했어" 만 가고 그림이 안 간 것이 그 경우다. 그 폴더에 파일이 생길 이유는
 * 방금 만들어 보여주려는 것 말고 없다.
 */

/** file:// 을 떼고 실제 경로만 남긴다. */
const asPath = (value) => {
  if (typeof value !== 'string' || !value) return null;
  if (!value.startsWith('file://')) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value.replace(/^file:\/\//, '');
  }
};

/** 이번 턴에 codex 가 만들어 보여준 그림. generated_images 아래만 인정한다. */
export function filesFrom(item, roots = mediaRoots()) {
  if (item?.type !== 'ImageView') return [];
  const file = asPath(item.path);
  if (!file) return [];
  return roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)) ? [file] : [];
}

const mediaRoots = () => [path.join(home(), 'generated_images')];

function createWatcher({ cwd, tmuxSession, pollMs, rescanMs, getInstance, updateInstance }) {
  let seen = new Set();
  let files = [];

  return new JsonlTailWatcher({
    pollMs,
    rescanMs,
    async locate() {
      const instance = getInstance?.();
      // 한 번 붙은 세션은 계속 그 세션만 본다. 사람이 같은 폴더에서 codex 를
      // 새로 띄워도 그쪽으로 넘어가지 않는다.
      if (instance?.codexSessionId) {
        claimRollout(instance.codexSessionId, tmuxSession);
        return locateRolloutById(instance.codexSessionId);
      }

      // 띄운 시각을 모르면 아무것도 잡지 않는다. 시각 없이 훑으면 그 폴더에서 가장
      // 최근에 움직인 세션을 물어 오는데, 그건 대개 남이 쓰고 있는 세션이다.
      // 폴더를 바꾸면(retarget) 기록이 비므로 여기 걸린 적이 있다.
      if (!instance?.launchedAt) return null;

      const found = await locateRollout(cwd, {
        after: instance.launchedAt,
        taken: (id) => rolloutTakenByOther(id, tmuxSession),
      });
      if (found?.sessionId) {
        claimRollout(found.sessionId, tmuxSession);
        await updateInstance?.({ codexSessionId: found.sessionId });
        return found;
      }

      // 이어 붙인 세션은 대개 원래 파일에 계속 쓴다. 그 파일은 시작 시각이 띄운
      // 시각보다 앞서 위 검색에서 걸러지므로, 걸었던 id 로 직접 집는다. 띄운 뒤에
      // 쓰인 흔적이 있어야 살아 있는 파일로 본다.
      const resumed = instance.resumedFrom;
      if (resumed && !rolloutTakenByOther(resumed, tmuxSession)) {
        const target = await locateRolloutById(resumed);
        if (target && target.mtimeMs >= instance.launchedAt - 5000) {
          claimRollout(resumed, tmuxSession);
          await updateInstance?.({ codexSessionId: resumed });
          return target;
        }
      }
      return null;
    },
    handleRecord(record, watcher) {
      if (record?.type !== 'event_msg') return;
      const payload = record.payload;

      if (payload?.type === 'task_started') {
        files = [];
        watcher.emit('turn-started', { turnId: payload.turn_id ?? null });
        return;
      }

      if (payload?.type === 'item_completed') {
        files.push(...filesFrom(payload.item));
      }

      // 작업 도중 에이전트가 내놓는 설명. phase 로 중간(commentary)과
      // 최종(final_answer)이 갈린다. 최종은 task_complete 로 따로 나가므로 여기선 뺀다.
      if (payload?.type === 'item_completed' && payload.item?.type === 'AgentMessage') {
        if (payload.item.phase === 'final_answer') return;
        const text = (payload.item.content ?? [])
          .filter((block) => block?.type === 'Text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text) watcher.emit('agent-message', { text, phase: payload.item.phase ?? null });
        return;
      }
      if (payload?.type !== 'task_complete') return;

      const turnId = payload.turn_id ?? null;
      if (turnId) {
        if (seen.has(turnId)) return;
        seen.add(turnId);
        if (seen.size > 500) seen = new Set([...seen].slice(-200));
      }
      const turnFiles = [...new Set(files)];
      files = [];
      watcher.emit('turn-completed', {
        turnId,
        message: payload.last_agent_message ?? '',
        durationMs: payload.duration_ms ?? null,
        files: turnFiles,
      });
    },
  });
}

export const codexAgent = {
  name: 'codex',
  defaultCommand: 'codex',
  // codex 는 작업 폴더를 인자로 못 박을 수 있다.
  launchArgs: (cwd) => ['--cd', cwd],
  // 그림을 만들면 작업 폴더가 아니라 여기에 떨군다: <CODEX_HOME>/generated_images/<세션 id>/
  mediaRoots,
  // codex resume <id> 로 이어 붙인다. 이때 rollout 파일이 새로 생길 수 있으므로
  // 기억해 둔 세션 id 를 지워 띄운 시각 기준으로 다시 찾게 한다.
  resumeArgs: (cwd, instance) => {
    // 이어 붙이면 codexSessionId 는 비워지고, 워처가 로그에서 다시 찾아 채운다.
    // 그 전에 한 번 더 띄우게 되면(이어 붙이기가 실패해 다시 시도하는 경우가 그렇다)
    // 빈 기록만 보고 새 대화를 시작해 버린다. 걸었던 id 를 같이 본다.
    const id = instance?.codexSessionId ?? instance?.resumedFrom;
    return id ? ['resume', id, '--cd', cwd] : null;
  },
  // 이어 붙일 때는 id 를 지우되 어느 세션에 걸었는지는 남긴다. resume 이 파일을 새로
  // 만들면 그걸 잡고, 원래 파일에 계속 쓰면 이 id 로 그 파일을 되찾는다.
  onResume: (instance) => ({
    ...instance,
    launchedAt: Date.now(),
    codexSessionId: undefined,
    resumedFrom: instance?.codexSessionId ?? instance?.resumedFrom ?? null,
  }),
  enterDelayMs: 3000,
  // 사람이 골라줘야 넘어가는 화면. 여기 걸리면 프롬프트가 그 창에 먹힌다.
  blockedPattern: /Esc to cancel|Enter to continue|to confirm|❯.*\[[ x]\]/,
  // 이 모양이면 이미 뭔가 돌리는 중이다.
  busyPattern: /esc to interrupt|Working \(/,
  readyPattern: /OpenAI Codex|Ask anything|to change/,
  completion: 'rollout jsonl 의 task_complete — 완료 시점과 답변 본문 모두 정확',
  createWatcher,
  inspect,
};
