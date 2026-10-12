import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadEnv({ path: path.join(projectRoot, '.env'), quiet: true });

const idList = (raw) =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const int = (raw, fallback) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/** .env 에 ~/workspace 라고 적을 수 있게 한다. */
export const expandHome = (value) =>
  value?.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;

const resolveDir = (value) => path.resolve(expandHome(value));

const routesFile = path.join(projectRoot, 'routes.json');
const routesFileJson = () => (fs.existsSync(routesFile) ? JSON.parse(fs.readFileSync(routesFile, 'utf8')) : {});

/**
 * 라우트 = "이 채널의 말은 이 폴더에서 도는 이 에이전트에게".
 * routes.json 이 있으면 그걸 쓰고, 없으면 .env 의 값으로 만든다.
 *
 * .env 로 만들 때는 최대 둘이다.
 *  - 채널을 콕 집은 라우트 (ALLOWED_CHANNEL_IDS + AGENT_CWD)
 *  - 그 밖의 채널·스레드가 쓰는 라우트 (NEW_SESSION_CWD)
 */
function loadRoutes() {
  const fromFile = routesFileJson();
  if (fromFile.routes || Array.isArray(fromFile)) {
    const list = Array.isArray(fromFile) ? fromFile : fromFile.routes;
    return list.map(normalizeRoute);
  }

  const agent = process.env.AGENT || 'codex';
  const command = process.env.AGENT_COMMAND || undefined;
  const pinnedChannels = idList(process.env.ALLOWED_CHANNEL_IDS);
  const routes = [];

  if (pinnedChannels.length > 0) {
    routes.push(
      normalizeRoute({
        agent,
        command,
        cwd: process.env.AGENT_CWD || process.cwd(),
        tmuxSession: process.env.TMUX_SESSION || undefined,
        channelIds: pinnedChannels,
      }),
    );
  }

  // 새로 뜨는 채널·스레드 세션은 다른 에이전트로 돌릴 수 있다.
  const openCwd = process.env.NEW_SESSION_CWD || (pinnedChannels.length === 0 ? process.env.AGENT_CWD : null);
  const openAgent = process.env.NEW_SESSION_AGENT || agent;
  const openCommand = process.env.NEW_SESSION_COMMAND || (openAgent === agent ? command : undefined);
  if (openCwd) {
    routes.push(normalizeRoute({ agent: openAgent, command: openCommand, cwd: openCwd, channelIds: [] }));
  }

  return routes;
}

/**
 * tmux 세션 이름.
 *
 * `tmux ls` 만 보고도 어느 에이전트가 어느 폴더에서 도는지 알 수 있어야 한다.
 * 채널·스레드가 여럿이면 같은 폴더를 쓸 수 있으므로 id 끝 네 자리를 붙여 가른다.
 */
// 같은 대화를 쓰는 변형은 묶음 이름으로 판을 잡는다. sonnet 으로 바꿔도 claude 판·기록을
// 그대로 써야 하던 대화가 이어진다.
const AGENT_FAMILY = { sonnet: 'claude' };

export function tmuxNameFor({ agent, cwd, scopeId = null }) {
  const parts = [AGENT_FAMILY[agent] ?? agent, path.basename(cwd)];
  if (scopeId) parts.push(String(scopeId).slice(-4));
  return parts
    .join('-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeRoute(raw) {
  const agent = raw.agent || 'codex';
  const cwd = resolveDir(raw.cwd || process.cwd());
  const channelIds = raw.channelIds ?? (raw.channelId ? [raw.channelId] : []);
  return {
    key: raw.key || `${agent}:${path.basename(cwd)}`,
    agent,
    cwd,
    command: raw.command || undefined,
    tmuxSession: raw.tmuxSession || tmuxNameFor({ agent, cwd }),
    channelIds: channelIds.map(String),
    userIds: (raw.userIds ?? []).map(String),
    // 스레드도 채널도 보통 작업 하나의 단위다. 각자 에이전트를 따로 띄워
    // 맥락이 섞이지 않게 하고, 여럿이 나란히 돌게 한다.
    perThread: raw.perThread !== false,
    perChannel: raw.perChannel !== false,
  };
}

/**
 * 이름이 겹치면 부모 폴더를 붙여 가른다.
 *
 * 루트를 여럿 두면 game/demo 와 workspace/demo 처럼 같은 이름이 생긴다.
 * 먼저 찾은 것만 남기면 나머지는 조용히 사라지고, 엉뚱한 폴더가 열려도 아무도
 * 모른다. 겹치는 것만 'game/demo' 처럼 한 단계 붙여 둘 다 고를 수 있게 한다.
 */
export function disambiguate(found) {
  const byName = new Map();
  for (const item of found) {
    const list = byName.get(item.name) ?? [];
    list.push(item);
    byName.set(item.name, list);
  }

  const map = {};
  for (const [name, list] of byName) {
    if (list.length === 1) {
      map[name] = list[0].dir;
      continue;
    }
    for (const item of list) {
      const parent = path.basename(path.dirname(item.dir));
      let key = `${parent}/${name}`;
      // 부모까지 같으면 한 단계 더 올라간다.
      let dir = path.dirname(item.dir);
      while (map[key] && map[key] !== item.dir) {
        dir = path.dirname(dir);
        key = `${path.basename(dir)}/${key}`;
      }
      map[key] = item.dir;
    }
  }
  return map;
}

/** 프로젝트 루트 바로 아래 폴더들을 이름으로 쓸 수 있게 훑는다. */
function scanRoots(roots) {
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      // 같은 폴더가 두 루트에 걸쳐 나오면(중첩된 루트) 한 번만 센다.
      if (!found.some((item) => item.dir === dir)) found.push({ name: entry.name, dir });
    }
  }
  return disambiguate(found);
}

/**
 * 채팅에서 골라 쓸 수 있는 프로젝트 폴더.
 * 임의 경로를 받지 않는다. 채팅에 쓴 글이 곧 에이전트의 실행 권한이기 때문이다.
 */
function loadProjects(routes, roots) {
  const map = scanRoots(roots);

  // 라우트가 이미 쓰는 폴더는 이름을 따로 안 적어도 쓸 수 있게 해둔다.
  for (const route of routes) {
    const name = path.basename(route.cwd);
    map[name] = route.cwd;
  }

  for (const [name, dir] of Object.entries(routesFileJson().projects ?? {})) map[name] = resolveDir(dir);

  // PROJECTS=my-game=/path/a,bridge=/path/b
  for (const entry of (process.env.PROJECTS ?? '').split(',')) {
    const [name, dir] = entry.split('=').map((s) => s?.trim());
    if (name && dir) map[name] = resolveDir(dir);
  }
  return map;
}

const routes = loadRoutes();
const projectRoots = idList(process.env.PROJECT_ROOTS).map(resolveDir);

export const config = {
  connector: process.env.CONNECTOR || 'discord',
  discordToken: process.env.DISCORD_TOKEN ?? '',

  // 어디서 쓸 수 있나. 채널을 하나씩 적거나, 서버 단위로 열거나.
  allowedChannelIds: idList(process.env.ALLOWED_CHANNEL_IDS),
  allowedGuildIds: idList(process.env.ALLOWED_GUILD_IDS),
  allowedUserIds: idList(process.env.ALLOWED_USER_IDS),

  // 작업 도중 에이전트가 내놓는 설명도 채널로 흘려보낼지.
  streamProgress: process.env.STREAM_PROGRESS !== 'false',

  // 봇을 멘션한 글에만 반응한다. 사람끼리 나누는 대화에 끼어들지 않는다.
  // DM 은 멘션할 수가 없으므로 이 규칙에서 제외한다.
  requireMention: process.env.REQUIRE_MENTION !== 'false',

  routes,
  projects: loadProjects(routes, projectRoots),
  // !project 로 없는 이름을 부르면 여기에 만든다.
  newProjectRoot: projectRoots[0] ?? resolveDir(process.env.NEW_SESSION_CWD || '~/workspace'),

  spoolDir: path.resolve(process.env.SPOOL_DIR || path.join(projectRoot, '.spool')),

  enterDelayMs: process.env.ENTER_DELAY_MS ? int(process.env.ENTER_DELAY_MS, 3000) : undefined,
  turnStartTimeoutMs: int(process.env.TURN_START_TIMEOUT_MS, 30_000),
  // 0 이면 제한 없음. 오래 걸리는 작업을 중간에 실패로 만들 이유가 없다.
  turnTimeoutMs: int(process.env.TURN_TIMEOUT_MS, 0),
  inlinePromptMaxChars: int(process.env.INLINE_PROMPT_MAX_CHARS, 700),

  pollMs: int(process.env.POLL_MS, 700),
  rescanMs: int(process.env.RESCAN_MS, 4000),
  idleMs: int(process.env.IDLE_MS, 4000),

  // 채널·스레드 세션이 이만큼 조용하면 닫는다. 작업 중이면 안 닫는다.
  threadIdleMs: int(process.env.THREAD_IDLE_MS, 30 * 60 * 1000),
  sweepMs: int(process.env.SWEEP_MS, 60 * 1000),
};

/** AgentSession 에 넘길 옵션으로 라우트를 편다. */
export function sessionOptions(route) {
  return {
    key: route.key,
    agentName: route.agent,
    // 아무도 말을 걸지 않은 상태에서 먼저 보낼 데가 필요하다 (늦게 끝난 답).
    channelId: route.channelIds?.[0] ?? null,
    cwd: route.cwd,
    command: route.command,
    tmuxSession: route.tmuxSession,
    spoolDir: config.spoolDir,
    enterDelayMs: config.enterDelayMs,
    turnStartTimeoutMs: config.turnStartTimeoutMs,
    turnTimeoutMs: config.turnTimeoutMs,
    inlinePromptMaxChars: config.inlinePromptMaxChars,
    pollMs: config.pollMs,
    rescanMs: config.rescanMs,
    idleMs: config.idleMs,
  };
}

export function configProblems() {
  const problems = [];
  if (config.connector === 'discord' && !config.discordToken) {
    problems.push('DISCORD_TOKEN 이 비어 있다. .env 에 봇 토큰을 넣어라.');
  }
  if (config.routes.length === 0) {
    problems.push('라우트가 하나도 없다. .env 의 AGENT_CWD / NEW_SESSION_CWD 를 채우거나 routes.json 을 만들어라.');
  }

  // 라우트마다 따로 본다. 채널을 콕 집은 라우트가 하나 있다고 채널 없는 라우트까지
  // 범위가 정해진 게 아니다.
  const globallyScoped =
    config.allowedChannelIds.length > 0 || config.allowedGuildIds.length > 0 || config.allowedUserIds.length > 0;
  const unscoped = config.routes.filter(
    (route) => route.channelIds.length === 0 && route.userIds.length === 0 && !globallyScoped,
  );
  if (unscoped.length > 0) {
    problems.push(
      `허용 범위가 없는 라우트가 있다: ${unscoped.map((route) => route.key).join(', ')} — ` +
        'ALLOWED_GUILD_IDS · ALLOWED_CHANNEL_IDS · ALLOWED_USER_IDS 중 하나를 채우거나 라우트에 userIds 를 적어라. ' +
        '아무나 에이전트를 실행하게 두지 않는다.',
    );
  }

  const duplicates = config.routes
    .map((route) => route.tmuxSession)
    .filter((name, index, all) => all.indexOf(name) !== index);
  if (duplicates.length > 0) {
    problems.push(`tmux 세션 이름이 겹친다: ${[...new Set(duplicates)].join(', ')} — 라우트마다 달라야 한다.`);
  }
  return problems;
}
