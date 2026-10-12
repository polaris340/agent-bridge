import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { JsonlTailWatcher, findFiles, readJsonlRecords } from '../watchers/jsonl-tail.js';

/**
 * Claude Code 는 ~/.claude/projects/<인코딩된 cwd>/<세션 uuid>.jsonl 에 기록하지만
 * codex 의 task_complete 같은 "턴 끝" 이벤트가 없다. 관측된 레코드는 최종 응답까지
 * 전부 stop_reason:"tool_use" 로 찍힌다. 그래서 경계를 이렇게 잡는다.
 *
 *   턴 시작 — type:"user" 이면서 message.content 가 문자열
 *             (도구 결과는 content 가 배열이라 사람이 친 입력과 구분된다)
 *   턴 종료 — 마지막 assistant 가 text 를 냈고 뒤따르는 tool_use 가 없는 상태로
 *             파일이 idleMs 동안 조용하면 완료로 본다
 *
 * tool_use 로 끝난 상태에서는 아무리 오래 조용해도 완료로 보지 않는다.
 * 도구가 오래 걸릴 때 답을 반쪽으로 끊어 보내는 오탐을 막는 장치다.
 */

const projectsRoot = () =>
  path.resolve(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'projects');

/** Claude 는 cwd 의 영숫자 아닌 문자를 '-' 로 바꿔 폴더명을 만든다. */
export const encodeProjectDir = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/**
 * 사람에게 보여 주려고 쓴 중간 설명인지. 요즘 claude 는 작업 도중 설명("원인을 두 가지
 * 찾았어요. 지금 고칠게요.")을 text 블록이 아니라 thinking 블록에 담고, 서명에
 * "narration" 표시를 붙인다. 화면에는 보통 글처럼 뜨는데 봇은 thinking 을 건너뛰어서
 * 채널에 안 갔다(10-02).
 *
 * 속생각은 내용이 비어 있다(최근 4천 건 중 255건 전부 빈 글). 그래도 속생각이 채널로
 * 새면 안 되므로 서명 표시까지 확인한다.
 */
function isNarration(block) {
  if (block?.type !== 'thinking' || typeof block.thinking !== 'string' || !block.thinking.trim()) return false;
  try {
    return Buffer.from(block.signature ?? '', 'base64').includes('narration');
  } catch {
    return false;
  }
}

function textOf(record) {
  const content = record?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      if (isNarration(block)) return block.thinking;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

const blockTypes = (record) => {
  const content = record?.message?.content;
  return Array.isArray(content) ? content.map((b) => b?.type) : [];
};

/**
 * 봇이 --session-id 로 못 박은 세션 파일. 이게 되면 남의 세션과 절대 섞이지 않는다.
 * (한 폴더에 claude 세션 파일이 수십 개씩 쌓이므로 "최근 파일" 로는 못 고른다)
 */
export async function locateSessionById(cwd, id) {
  const file = path.join(projectsRoot(), encodeProjectDir(cwd), `${id}.jsonl`);
  try {
    const st = await fsp.stat(file);
    return { file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size };
  } catch {
    /* 그 폴더에 없으면 아래에서 더 찾아본다 */
  }

  // 에이전트가 작업 폴더를 옮기면(워크트리를 만들어 들어가는 등) 세션 로그도
  // 그 폴더 쪽으로 따라간다. 같은 세션이므로 id 로 전체를 훑어 따라간다.
  const found = await findFiles(projectsRoot(), (name) => name === `${id}.jsonl`);
  return found[0] ?? null;
}

/** 이 cwd 의 가장 최근 세션 파일. 폴더명 규칙이 어긋나면 레코드의 cwd 로 확인한다. */
export async function locateSession(cwd, { limit = 12 } = {}) {
  const root = projectsRoot();
  const isJsonl = (name) => name.endsWith('.jsonl');

  const direct = await findFiles(path.join(root, encodeProjectDir(cwd)), isJsonl);
  if (direct.length > 0) return direct[0];

  // 인코딩 규칙이 바뀐 경우의 대비책 — 전체를 훑어 레코드의 cwd 로 맞춘다.
  const all = await findFiles(root, isJsonl);
  for (const candidate of all.slice(0, limit)) {
    const records = await readJsonlRecords(candidate.file);
    const recorded = records.find((r) => typeof r?.cwd === 'string')?.cwd;
    if (recorded && path.resolve(recorded) === path.resolve(cwd)) return candidate;
  }
  return null;
}

/** doctor 용 — 실제 로그에서 사람 입력과 답변이 구분돼 나오는지 확인한다. */
async function inspect(cwd) {
  const target = await locateSession(cwd);
  if (!target) return null;
  const records = await readJsonlRecords(target.file);
  const real = records.filter((r) => r?.isSidechain !== true);
  const turns = real.filter((r) => r?.type === 'user' && typeof r?.message?.content === 'string').length;
  const texts = real.filter((r) => r?.type === 'assistant').map(textOf).filter(Boolean);
  return { file: target.file, turns, lastMessage: texts.at(-1) ?? '' };
}

/**
 * 에이전트가 SendUserFile 로 보내겠다고 한 파일.
 *
 * 이게 가장 확실한 신호다. 무엇을 보여주려 했는지 에이전트가 직접 말한 것이라
 * 새로 생긴 파일을 찾아 헤매거나 답변에서 경로를 긁을 필요가 없다.
 * 다만 그 도구가 보내는 곳은 채팅이 아니라서, 채널에는 아무것도 안 뜬다.
 */
function sentFilesIn(record) {
  const content = record?.message?.content;
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const block of content) {
    if (block?.type !== 'tool_use' || block.name !== 'SendUserFile') continue;
    for (const file of block.input?.files ?? []) {
      if (typeof file === 'string' && file.trim()) out.push(file.trim());
    }
  }
  return out;
}

/**
 * 에이전트가 Read 로 읽은 그림. 세션 로그에 base64 로 통째로 남는다.
 *
 * 에이전트에게는 채팅으로 그림을 보낼 수단이 없어서, 읽어 놓고 "보여드렸다" 고 말한다.
 * 정작 사람 화면에는 아무것도 안 뜬다. 그래서 읽은 그림을 대신 올려 준다.
 */
function imagesIn(record) {
  const content = record?.message?.content;
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const block of content) {
    const inner = block?.type === 'tool_result' && Array.isArray(block.content) ? block.content : [block];
    for (const item of inner) {
      if (item?.type !== 'image') continue;
      const source = item.source ?? {};
      if (source.type !== 'base64' || !source.data) continue;
      out.push({ mediaType: source.media_type ?? 'image/png', data: source.data });
    }
  }
  return out;
}

function createWatcher({ cwd, pollMs, rescanMs, idleMs = 4000, getInstance }) {
  let inTurn = false;
  let awaitingTool = false;
  let pendingText = [];
  let seenImages = [];
  let sentFiles = [];
  let idleTimer = null;
  let turnSeq = 0;
  let turnId = null;

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  // 지금 턴의 답을 내보낸다. 도구를 기다리는 중이거나 낸 말이 없으면 아직 끝이 아니다.
  let emitter = null;
  const finish = () => {
    if (!inTurn || awaitingTool || pendingText.length === 0 || !emitter) return;
    const message = pendingText.join('\n\n');
    const images = seenImages;
    const files = [...new Set(sentFiles)];
    inTurn = false;
    pendingText = [];
    seenImages = [];
    sentFiles = [];
    emitter.emit('turn-completed', { turnId, message, durationMs: null, images, files });
  };

  const watcher = new JsonlTailWatcher({
    pollMs,
    rescanMs,
    locate: async () => {
      // 봇이 --session-id 로 못 박은 세션만 본다.
      //
      // 예전에는 그 파일이 안 보이면 폴더에서 가장 최근 것을 대신 잡았는데,
      // 사람이 직접 돌리는 대화를 주워 왔다. 실제로 두 달 전부터 쓰던 132MB 짜리
      // 세션을 자기 것으로 적어 두고 이어 붙이려다 죽었다. 폴더를 옮겨 간 경우는
      // locateSessionById 가 id 로 전체를 훑어 따라가므로 이 길은 필요 없다.
      const id = getInstance?.()?.id;
      return id ? locateSessionById(cwd, id) : null;
    },
    handleRecord(record, self) {
      emitter = self;
      // 서브에이전트(Task) 로그는 본 턴의 답이 아니다.
      if (record?.isSidechain === true) return;

      const type = record?.type;

      // claude 는 턴이 끝나면 system/turn_duration 을 남긴다. 조용해지길 기다리는 것보다
      // 정확해서 이걸 보면 바로 마감한다.
      if (type === 'system' && record?.subtype === 'turn_duration') {
        clearIdle();
        finish();
        return;
      }

      if (type !== 'user' && type !== 'assistant') return;

      if (type === 'user') {
        const content = record?.message?.content;
        if (typeof content === 'string') {
          // 새 턴이 시작되기 전에 앞 턴의 답이 남아 있으면 먼저 내보낸다. 답한 직후 다른
          // 세션의 메시지("Another Claude session sent a message")가 같은 초에 들어와
          // 새 턴을 열면서, 조용해지길 기다리던 답을 그대로 지워 버렸다(10-01).
          clearIdle();
          finish();
          // 사람이 친 입력 = 새 턴 시작
          inTurn = true;
          awaitingTool = false;
          pendingText = [];
          seenImages = [];
          sentFiles = [];
          turnId = `claude-${++turnSeq}`;
          self.emit('turn-started', { turnId });
        } else {
          // 도구 결과가 돌아왔다. 아직 턴이 돌아가는 중이다.
          awaitingTool = false;
          // 마지막에 읽은 것이 대개 보여주려던 것이다. 뒤에서 두 장만 들고 간다.
          seenImages = [...seenImages, ...imagesIn(record)].slice(-2);
        }
      } else {
        // 에이전트가 말하고 있으면 턴 안이다. 봇이 턴 도중에 붙으면(재시작 뒤 다시 붙을 때)
        // 턴 시작 기록을 못 봐서 이 표시가 꺼진 채였고, 그 턴의 답을 통째로 버렸다(10-10).
        // 작업 중에 넣은 말도 사람 입력 기록 없이 대기열로 들어가 같은 일이 생긴다.
        if (!inTurn) {
          inTurn = true;
          turnId = `claude-${++turnSeq}`;
        }
        const types = blockTypes(record);
        sentFiles.push(...sentFilesIn(record));
        if (types.includes('tool_use')) {
          awaitingTool = true;
          // 도구를 쓰기 직전까지 낸 말은 최종 답이 아니라 작업 도중의 설명이다.
          if (pendingText.length > 0) {
            self.emit('agent-message', { text: pendingText.join('\n\n'), phase: 'commentary' });
            pendingText = [];
          }
        }
        const text = textOf(record);
        if (text) pendingText.push(text);
      }

      // 레코드가 하나 들어올 때마다 조용해질 시간을 다시 잰다.
      // turn_duration 을 안 남기는 버전을 위한 예비 판정이다.
      clearIdle();
      idleTimer = setTimeout(finish, idleMs);
    },
  });

  const stop = watcher.stop.bind(watcher);
  watcher.stop = () => {
    clearIdle();
    stop();
  };
  return watcher;
}

/**
 * CLAUDE_REMOTE_CONTROL=true 면 봇이 띄운 세션을 Remote Control 로도 열어 둔다.
 * 기본은 끈다 — 켜면 claude.ai 계정에서 이 세션들이 보이고 들어갈 수 있다.
 * optional 인자를 받는 플래그라 뒤에 다른 인자가 붙지 않게 맨 끝에 둔다.
 */
const remoteControlArgs = () => (process.env.CLAUDE_REMOTE_CONTROL === 'true' ? ['--remote-control'] : []);

function makeClaudeAgent({ name, modelArgs = [] }) {
  return {
  name,
  // 같은 claude 대화를 쓰는 묶음. 모델만 바꿔 띄우는 변형(sonnet)과 기록·판을 같이 쓴다.
  family: 'claude',
  defaultCommand: 'claude',
  // claude 는 첫 메시지를 받기 전에는 대화 파일을 만들지 않는다(띄워 놓고 말을 안 걸어
  // 확인했다). 봇은 띄우는 순간 id 를 적어 두므로, 첫 메시지가 안 들어간 채 끝나면 —
  // 폴더 신뢰 화면에 걸렸다거나 재부팅됐다거나 — 영영 생기지 않을 대화를 가리킨다.
  // 그 id 로 --resume 하면 "No conversation found" 를 찍고 곧바로 죽는다.
  hasConversation: async (cwd, instance) => Boolean(instance?.id && (await locateSessionById(cwd, instance.id))),
  // 작업 폴더 인자는 없다 — tmux 세션을 그 폴더에서 열어 맞춘다.
  // 세션 id 는 봇이 정한다. 그래야 볼 로그 파일이 확정된다.
  launchArgs: (_cwd, instance, { tmuxSession } = {}) => {
    const args = [];
    if (instance?.id) args.push('--session-id', instance.id);
    // 세션 이름을 tmux 와 맞춰야 claude 쪽 목록에서도 어느 채널의 것인지 알아본다.
    if (tmuxSession) args.push('--name', tmuxSession);
    args.push(...modelArgs, ...remoteControlArgs());
    return args;
  },
  // --resume 은 원래 세션 id 를 그대로 쓴다 (새 id 를 원하면 --fork-session).
  // 그래서 보던 로그 파일도 그대로라 감시를 이어받을 수 있다.
  resumeArgs: (_cwd, instance, { tmuxSession } = {}) => {
    if (!instance?.id) return null;
    const args = ['--resume', instance.id];
    if (tmuxSession) args.push('--name', tmuxSession);
    args.push(...modelArgs, ...remoteControlArgs());
    return args;
  },
  onResume: (instance) => ({ ...instance, launchedAt: Date.now() }),
  enterDelayMs: 1500,
  // 사람이 골라줘야 넘어가는 화면. 여기 걸리면 프롬프트가 그 창에 먹힌다.
  blockedPattern: /Esc to cancel|Enter to continue|to confirm|❯.*\[[ x]\]/,
  // 이 모양이면 이미 뭔가 돌리는 중이다.
  busyPattern: /esc to interrupt/,
  // 입력창과 하단 상태줄이 그려지면 준비된 것이다. 입력창 아래 상태줄로만 판정한다. ❯ 는 선택 창의 커서에도 쓰여서, 신뢰 확인 창을
  // 입력창으로 잘못 읽고 거기에 지시를 쳐 넣었다.
  readyPattern: /shift\+tab|\? for shortcuts/,
  // 폴더 신뢰 확인. 2.1.281 부터 문구가 바뀌었고 기본 선택이 "No, exit" 로 올라왔다.
  // 그대로 Enter 를 치면 claude 가 꺼진다. 커서가 어디
  // 있든 "Yes" 로 옮겨서 누른다.
  startupPrompts: [
    {
      pattern: /Do you trust|Is this a project you created or one you trust|Yes, I trust this folder/i,
      keysFor: (screen) => (/❯\s*Yes/.test(screen) ? ['Enter'] : ['Down', 'Enter']),
      label: '폴더 신뢰 확인',
    },
  ],
  settleMs: 2000,

  completion: '세션 jsonl 이 text 로 끝난 뒤 조용해지면 완료 (도구 대기 중에는 끊지 않음)',
  createWatcher,
  inspect,
};
}

export const claudeAgent = makeClaudeAgent({ name: 'claude' });

// !agent sonnet. 하던 claude 대화를 그대로 이어서, 모델만 바꿔 띄운다.
export const sonnetAgent = makeClaudeAgent({
  name: 'sonnet',
  modelArgs: ['--model', 'sonnet'],
});
