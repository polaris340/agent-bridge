import fs from 'node:fs';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { withSpeaker } from './speaker.js';
import { collectImages, describeTooBig, resolveSentFiles, saveInlineImages } from './images.js';
import { knownAgentNames } from './agents/index.js';
import { config, configProblems } from './config.js';
import { createConnector } from './connectors/index.js';
import { acquireLock } from './lock.js';
import { Router } from './router.js';

const problems = configProblems();
if (problems.length > 0) {
  console.error('설정이 덜 됐다:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\n.env.example / routes.example.json 을 참고해라.');
  process.exit(1);
}

let release;
try {
  release = await acquireLock(config.spoolDir);
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}

const idleMinutes = Math.round(config.threadIdleMs / 60_000);

const execFileAsync = promisify(execFile);

/** 세션마다 마지막으로 말을 건 곳. 늦게 끝난 작업의 답을 여기로 보낸다. */
const lastReply = new Map();

/**
 * 이번 턴에 말을 건 사람들. 최종 답이 나오면 이 사람들한테만 알림이 가게 한다(채널에 빨간
 * 점). 봇을 다시 띄워도 늦게 끝난 답의 주인을 알도록 파일에도 적어 둔다.
 */
const askersFile = path.join(config.spoolDir, 'askers.json');
const askers = new Map(
  Object.entries((() => {
    try {
      return JSON.parse(fs.readFileSync(askersFile, 'utf8'));
    } catch {
      return {};
    }
  })()),
);
function saveAskers() {
  fsp.writeFile(askersFile, JSON.stringify(Object.fromEntries(askers)), 'utf8').catch(() => {});
}
function addAsker(key, userId) {
  if (!userId) return;
  const list = askers.get(key) ?? [];
  if (!list.includes(String(userId))) askers.set(key, [...list, String(userId)]);
  saveAskers();
}
/** 이번 턴의 알림 대상을 꺼내고 비운다. */
function takeAskers(key) {
  const list = askers.get(key) ?? [];
  askers.delete(key);
  saveAskers();
  return list;
}

/**
 * 눈알(👀)을 달아 둔 메시지들. "봤다" 는 표시라서 답이 나가기 시작하면 뗀다.
 * 답을 기다리는 사이에 온 메시지들은 같은 턴에 묶이므로 한꺼번에 뗀다.
 */
const watching = new Map();

function watch(session, ctx) {
  const list = watching.get(session.key) ?? [];
  list.push(ctx);
  watching.set(session.key, list);
}

async function unwatch(session) {
  const list = watching.get(session.key);
  if (!list?.length) return;
  watching.set(session.key, []);
  for (const item of list) await item.unreact('👀');
}

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/**
 * 채팅에 붙여 보낸 파일을 받아 두고 그 경로를 돌려준다.
 * 에이전트에게는 경로만 알려주고 읽는 건 맡긴다. 이미지도 마찬가지다.
 */
async function saveAttachments(list = []) {
  if (list.length === 0) return [];

  const dir = path.join(config.spoolDir, 'files');
  await fsp.mkdir(dir, { recursive: true });

  const saved = [];
  for (const item of list) {
    if (item.size > MAX_ATTACHMENT_BYTES) {
      console.warn(`[files] ${item.name} 은 너무 커서 건너뛴다 (${item.size} 바이트)`);
      continue;
    }
    // 파일 이름은 그대로 쓰지 않는다. 경로를 벗어나거나 서로 덮어쓰지 않게.
    const safe = (item.name || 'file').replace(/[^\w.\-가-힣]/g, '_').slice(-80);
    const file = path.join(dir, `${Date.now()}-${safe}`);
    try {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await fsp.writeFile(file, Buffer.from(await response.arrayBuffer()));
      saved.push(file);
    } catch (err) {
      console.error(`[files] ${item.name} 받기 실패: ${err.message}`);
    }
  }
  return saved;
}

/** `!agent` 로 고를 수 있는 이름. 어댑터가 있는 것과 운영자가 라우트에 적어 둔 것뿐이다. */
const allowedAgentNames = [
  ...new Set([...knownAgentNames.filter((name) => name !== 'generic'), ...config.routes.map((route) => route.agent)]),
];

/** 폴더 이름으로 받아도 되는 글자. 경로를 벗어나는 이름을 막는다. */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * 줄바꿈이 섞이거나 긴 메시지는 파일로 넘기기 때문에 .spool 에 하나씩 쌓인다.
 * 하루 지난 것은 치운다.
 */
async function cleanSpool() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    const targets = [
      ...(await fsp.readdir(config.spoolDir)).filter((n) => n.startsWith('prompt-')).map((n) => path.join(config.spoolDir, n)),
      ...(await fsp.readdir(path.join(config.spoolDir, 'files')).catch(() => [])).map((n) =>
        path.join(config.spoolDir, 'files', n),
      ),
    ];
    for (const file of targets) {
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat || stat.mtimeMs >= cutoff) continue;
      await fsp.rm(file, { force: true });
      removed += 1;
    }
  } catch {
    /* 폴더가 아직 없으면 치울 것도 없다 */
  }
  if (removed > 0) console.log(`[bot] 오래된 스풀 파일 ${removed}개 정리`);
}

const router = new Router(config.routes, {
  onSessionReady: (session) => attachHandlers(session),
  onSessionClosed: async (session) => {
    if (!session.channelId) return;
    await connector.send(
      session.channelId,
      `${idleMinutes}분 동안 조용해서 **${session.agentName}** 을 내렸다.\n` +
        '다시 말 걸면 하던 얘기를 이어서 띄운다.',
    );
  },
});

async function handleCommand(session, ctx, text) {
  const [command] = text.slice(1).split(/\s+/);

  switch (command) {
    case 'help':
      await ctx.reply(
        [
          `여기 말은 **${session.agentName}** 에게 간다 (\`${session.cwd}\`).`,
          session.isDynamic
            ? `이 스레드 전용 세션이다. ${idleMinutes}분 조용하면 정리된다.`
            : '이 채널의 기본 세션이다. 스레드를 열면 거기 전용 에이전트가 따로 뜬다.',
          '',
          '`!project` 폴더 목록 / `!project <이름>` 그 폴더로 옮기기',
          '`!agent` 에이전트 보기 / `!agent codex` 처럼 바꾸기',
          '`!status` 세션 상태 / `!pane` 지금 화면 / `!esc` 진행 중인 작업 중단',
          '`!agents` 떠 있는 에이전트 전부 / `!restart` 재시작 (대화 맥락이 날아간다)',
        ].join('\n'),
      );
      return true;

    case 'status': {
      const status = await session.status();
      await ctx.reply(
        [
          `에이전트: **${status.agent}** (${session.agent.completion})`,
          `작업 폴더: \`${status.cwd}\``,
          `tmux: \`${status.tmuxSession}\` ${status.sessionExists ? '있음' : '없음'}` +
            (status.paneCommand ? ` / pane \`${status.paneCommand}\`` : ''),
          `실행 중: ${status.agentRunning ? '예' : '아니오'}`,
          `보는 로그: \`${status.watchingFile ?? '(화면 감시 방식)'}\``,
          `상태: ${status.busy ? '작업 중 (지금 보내면 그대로 전달된다)' : '대기'}`,
          session.isDynamic ? `이 스레드 전용 — ${idleMinutes}분 조용하면 정리` : '채널 기본 세션 — 자동 정리 안 함',
        ].join('\n'),
      );
      return true;
    }

    case 'agents': {
      const lines = await Promise.all(
        router.sessions.map(async (item) => {
          const status = await item.status();
          const here = item.key === session.key ? ' ← 여기' : '';
          const kind = item.isDynamic ? '스레드' : '채널';
          return `- \`${item.key}\` ${status.agent} / ${kind} / ${status.agentRunning ? '실행 중' : '멈춤'}${here}`;
        }),
      );
      await ctx.reply(lines.join('\n') || '떠 있는 세션이 없다.');
      return true;
    }

    case 'project':
    case 'cd': {
      const name = text.trim().split(/\s+/)[1];
      const names = Object.keys(config.projects).sort();
      const hereName = names.find((n) => config.projects[n] === session.cwd);

      if (!name) {
        const list = names.map((n) => `${n === hereName ? '▸' : '  '} ${n}`).join('\n');
        await ctx.reply(
          `지금 폴더: **${hereName ?? session.cwd}**\n\`\`\`\n${list}\n\`\`\`\n` +
            '옮기려면 `!project <이름>`. 없는 이름을 부르면 새로 만든다.',
        );
        return true;
      }

      if (await session.isWorking()) {
        await ctx.reply('지금 작업 중이라 폴더를 못 바꾼다. 끝난 뒤에 다시 해라 (`!esc` 로 중단할 수 있다).');
        return true;
      }

      let target = Object.hasOwn(config.projects, name) ? config.projects[name] : undefined;
      let created = false;

      if (!target) {
        if (!SAFE_NAME.test(name)) {
          await ctx.reply('폴더 이름에는 영문·숫자와 `.` `_` `-` 만 쓸 수 있다.');
          return true;
        }
        target = path.join(config.newProjectRoot, name);
        await fsp.mkdir(target, { recursive: true });
        // 에이전트는 git 저장소 안에서 훨씬 안정적으로 돈다.
        await execFileAsync('git', ['init', '-q'], { cwd: target }).catch(() => {});
        config.projects[name] = target;
        created = true;
      }

      const moved = await session.retarget({ cwd: target });
      await router.remember(session.scopeId, { cwd: target });

      const where = `**${name}**\n\`${target}\``;
      if (created) await ctx.reply(`폴더가 없어서 새로 만들었다.\n${where}\n다음 메시지부터 여기서 돈다.`);
      else if (moved) await ctx.reply(`${where} 로 옮겼다.\n에이전트는 새로 뜨고 이전 대화 맥락은 없다.`);
      else await ctx.reply(`이미 ${where} 에 있다.`);
      return true;
    }

    case 'agent': {
      const name = text.trim().split(/\s+/)[1];
      const known = allowedAgentNames.join(', ');

      if (!name) {
        await ctx.reply(
          `지금 이 채널은 **${session.agentName}** 이다.\n` + `바꾸려면 \`!agent <이름>\`. 쓸 수 있는 것: ${known}`,
        );
        return true;
      }
      // 채팅에 적힌 이름을 그대로 실행하지 않는다. 그러면 PATH 의 아무 프로그램이나 띄울 수 있다.
      if (!allowedAgentNames.includes(name)) {
        await ctx.reply(`**${name}** 은 쓸 수 없다. 쓸 수 있는 것: ${known}`);
        return true;
      }
      if (name === session.agentName) {
        await ctx.reply(`이미 **${name}** 이다.`);
        return true;
      }
      if (await session.isWorking()) {
        await ctx.reply('지금 작업 중이라 못 바꾼다. 끝난 뒤에 다시 해라 (`!esc` 로 중단할 수 있다).');
        return true;
      }

      const changed = await session.retarget({ agentName: name });
      await router.remember(session.scopeId, { agent: name });
      await ctx.reply(
        `이 채널을 **${name}** 으로 바꿨다 (\`${session.tmuxSession}\`).\n` +
          (changed === 'kept'
            ? '하던 대화는 그대로 이어서, 다음 메시지부터 새 설정으로 뜬다.'
            : '다음 메시지부터 새로 뜬다. 이전 대화 맥락은 없다.'),
      );
      return true;
    }

    case 'pane':
      await ctx.reply(`\`\`\`\n${await session.snapshot(40)}\n\`\`\``);
      return true;

    case 'esc':
    case 'cancel':
      await session.interrupt();
      await ctx.reply('중단 키를 보냈다.');
      return true;

    case 'restart':
      await session.restart();
      await ctx.reply(`${session.agentName} 을 새로 띄웠다. 이전 대화 맥락은 없다.`);
      return true;

    default:
      return false;
  }
}

/**
 * 세션 하나에 붙는 알림들. 사람이 말을 걸어서 만들어진 세션이든, 봇이 시작하면서
 * 돌고 있는 판에 다시 붙은 세션이든 똑같이 붙는다.
 *
 * 보낼 곳은 두 군데다. 마지막으로 말을 건 메시지에 답장하는 게 기본이고, 그런 게
 * 없으면(봇을 껐다 켠 뒤가 그렇다) 세션이 매인 채널로 그냥 보낸다.
 */
function attachHandlers(session) {
  const speak = async (content, files = []) => {
    const target = lastReply.get(session.key);
    if (target) return target.reply(content, files);
    if (session.channelId) return connector.send(session.channelId, content, files);
    console.log(`[${session.key}] 보낼 곳이 없어 흘린다: ${String(content).slice(0, 80)}`);
    return undefined;
  };

  session.onOrphan ??= async (result) => {
    const answer = result.message?.trim();
    if (!answer) return;
    try {
      const { body, images } = await renderAnswer(session, result);
      await unwatch(session);
      const who = takeAskers(session.key);
      const target = lastReply.get(session.key);
      const text = `⌛ 늦게 끝났다.\n\n${body}`;
      if (target) {
        await target.reply(text, images, { ping: true, mention: who.filter((id) => id !== String(target.userId)) });
      } else if (session.channelId) {
        await connector.send(session.channelId, text, images, { mention: who });
      }
    } catch (err) {
      console.error(`[${session.key}] 늦은 답장 실패: ${err.message}`);
    }
  };

  // 작업 도중 에이전트가 내놓는 설명을 그때그때 흘려보낸다.
  // 그림도 여기서 보여주는 일이 잦다 — 만들어 놓고 "이거 봐" 하는 건 대개 작업 도중이다.
  // 글만 보내면 채널에는 마크다운 링크 글자만 남는다.
  session.onProgress ??= (payload) => {
    if (!config.streamProgress) return;
    const line = payload?.text?.trim();
    if (!line) return;
    void unwatch(session);
    void (async () => {
      const shown = await collectImages(line, session.cwd, { extraRoots: session.mediaRoots });
      await speak(`> ${line.slice(0, 1500)}`, shown.files.slice(0, 5));
    })();
  };

  // 이어 붙이지 못했으면 그 사실을 알린다. 조용히 새로 시작하면
  // 에이전트가 앞 얘기를 모르는 걸 사람만 모른다.
  session.onResumeSkipped ??= (reason) => {
    void speak(
      `⚠️ 하던 대화를 이어 붙이지 못해서 새로 시작한다.${reason ? `\n> ${String(reason).slice(0, 300)}` : ''}\n` +
        '앞의 얘기는 기억하지 못하니 필요한 건 다시 알려줘라.',
    );
  };

  // 사람이 골라줘야 넘어가는 화면에 걸리면 그대로 두지 말고 알린다.
  session.onBlocked ??= (screen) => {
    void speak(
      `⚠️ **${session.agentName}** 이 뭔가 물어보고 있어서 멈춰 있다. tmux 에서 골라줘야 넘어간다.\n` +
        `\`tmux attach -t ${session.tmuxSession}\`\n\`\`\`\n${screen.slice(-1200)}\n\`\`\``,
    );
  };
}

/** 턴 결과를 채널에 올릴 모양으로 만든다. 답장이든 늦은 답이든 같은 모양이다. */
async function renderAnswer(session, result) {
  const answer = result.message?.trim();
  // 답변 본문에 경로를 적은 그림을 올린다. 만들어 놓기만 한 것은 올리지 않는다 —
  // 확인하려고 열어 본 그림까지 올리면 같은 그림이 턴마다 도배된다.
  // claude 의 SendUserFile 은 "보내겠다" 는 명시라 그것만 예외로 앞세운다.
  const sent = await resolveSentFiles(result.files, session.cwd, { extraRoots: session.mediaRoots });
  const mentioned = await collectImages(answer, session.cwd, { extraRoots: session.mediaRoots });
  const seen = sent.files.length > 0 ? [] : await saveInlineImages(result.images, path.join(config.spoolDir, 'files'));
  // 같은 그림을 다시 올리는 것을 막지 않는다. 한때 지문을 기억해 걸렀는데, 정작
  // "아까 그 4번" 처럼 일부러 다시 보여주는 것까지 막혔다.
  const images = [...new Set([...sent.files, ...mentioned.files, ...seen])].slice(0, 5);
  // 한도를 넘어 못 올린 것은 조용히 빠뜨리지 않고 알린다.
  const oversize = describeTooBig([...sent.tooBig, ...mentioned.tooBig]);
  // 중간 설명이 줄줄이 나간 뒤라 어디가 끝인지 보이게 체크를 붙인다.
  const body = answer ? `${answer}\n\n✅` : '(턴은 끝났는데 답변 본문이 비어 있다. `!pane` 으로 화면을 봐라.)';
  return { body: oversize ? `${body}\n\n${oversize}` : body, images };
}

async function onMessage(ctx) {
  // 멘션한 글에만 반응한다. DM 은 멘션할 수가 없으니 예외.
  if (config.requireMention && !ctx.mentioned && !ctx.isDirect) return;
  if (!ctx.text && !ctx.attachments?.length) return;

  let session;
  try {
    session = await router.resolve(ctx);
  } catch (err) {
    console.error('[route]', err);
    await ctx.reply(`세션을 여는 데 실패했다: ${err.message}`);
    return;
  }
  if (!session) return;

  if (ctx.text.startsWith('!')) {
    try {
      if (await handleCommand(session, ctx, ctx.text)) return;
    } catch (err) {
      await ctx.reply(`명령 처리 중 실패: ${err.message}`);
      return;
    }
  }

  // 늦게 끝난 답과 중간 설명이 이 채널로 가게 해 둔다.
  lastReply.set(session.key, ctx);
  addAsker(session.key, ctx.userId);

  // 붙잡아 두지 않는다. 작업 중이면 에이전트가 알아서 반영한다.
  await ctx.react('👀');
  watch(session, ctx);
  try {
    const files = await saveAttachments(ctx.attachments);
    const body = files.length
      ? [ctx.text || '붙인 파일을 봐라.', `[붙인 파일: ${files.join(', ')}]`].join(' ')
      : ctx.text;
    const prompt = withSpeaker(body, ctx.displayName || ctx.userName);

    const result = await session.runTurn(prompt, {
      log: (message) => console.log(`[${session.key}] ${message}`),
    });

    // 답을 기다리는 사이에 더 보낸 메시지들은 같은 턴에 합쳐진다.
    // 답장은 마지막 메시지에 한 번만 단다.
    if (result.primary !== false) {
      await unwatch(session);
      const { body, images } = await renderAnswer(session, result);
      // 최종 답만 알림을 켠다. 답장하는 사람 말고도 이번 턴에 말을 섞은 사람이 있으면 같이 부른다.
      const others = takeAskers(session.key).filter((id) => id !== String(ctx.userId));
      await ctx.reply(body, images, { ping: true, mention: others });
    }
  } catch (err) {
    // 화면 스냅샷은 채널에 뿌리지 않는다. 길고 대개 도움이 안 된다.
    // 필요하면 `!pane` 으로 직접 보면 되고, 진단용으로 서버 로그에는 남긴다.
    console.error(`[${session.tmuxSession}] ${err.message}\n${await session.snapshot(30)}`);
    await unwatch(session).catch(() => {});
    // 이 알림조차 못 보내는 경우가 있다(네트워크가 끊겼을 때). 실패를 여기서 삼킨다.
    // 실패도 턴이 끝난 것이다. 최종 답처럼 알림을 건다.
    const others = takeAskers(session.key).filter((id) => id !== String(ctx.userId));
    await ctx.reply(`❌ ${err.message}`, [], { ping: true, mention: others }).catch((sendErr) => {
      console.error(`[${session.key}] 실패 알림도 못 보냈다: ${sendErr.message}`);
    });
  }
}

const connector = createConnector(config.connector, { token: config.discordToken, onMessage });

await router.start();
for (const session of router.sessions) {
  console.log(`[route] ${session.key} → ${session.agentName} @ ${session.cwd} (tmux ${session.tmuxSession})`);
}

void cleanSpool();
setInterval(() => void cleanSpool(), 6 * 60 * 60 * 1000);

await connector.start();
console.log(
  `[bot] 준비됐다. 커넥터 ${connector.name} / 라우트 ${config.routes.length}개 / 스레드 세션은 ${idleMinutes}분 idle 시 정리`,
);

async function shutdown(signal) {
  console.log(`\n[bot] ${signal} — 정리하고 종료한다. tmux 세션은 그대로 둔다.`);
  router.stop();
  await connector.stop();
  await release?.();
  process.exit(0);
}
// 네트워크가 잠깐 끊기면 디스코드로 보내던 답장이 거부된 채 떠돌다가 봇을 통째로 죽였다
// (ConnectTimeoutError). 답장 하나 못 보낸 걸로 모든 채널이 멈출 이유는 없다.
// 남기고 계속 돈다.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  console.error(`[bot] 처리되지 않은 실패 — 봇은 계속 돈다: ${message.slice(0, 300)}`);
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
