/**
 * 커넥터 없이 브리지 왕복을 확인한다.
 *   tmux 에 에이전트 띄우기 → 프롬프트 주입 → 완료 감지 → 답변 회수
 *
 *   node src/selftest.js                              # 첫 라우트로
 *   node src/selftest.js --route codex:my-game "안녕"
 *   node src/selftest.js --agent claude --cwd /path "안녕"
 */
import { config, normalizeRoute, sessionOptions } from './config.js';
import { AgentSession } from './session.js';

const argv = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--agent' || arg === '--cwd' || arg === '--session' || arg === '--route' || arg === '--command') {
    flags[arg.slice(2)] = argv[++i];
  } else {
    words.push(arg);
  }
}

const base = flags.route
  ? config.routes.find((route) => route.key === flags.route)
  : (config.routes[0] ?? null);

if (flags.route && !base) {
  console.error(`라우트 '${flags.route}' 가 없다. 있는 것: ${config.routes.map((r) => r.key).join(', ')}`);
  process.exit(1);
}

const route = normalizeRoute({
  agent: flags.agent ?? base?.agent ?? 'codex',
  cwd: flags.cwd ?? base?.cwd ?? process.cwd(),
  command: flags.command ?? (flags.agent ? undefined : base?.command),
  tmuxSession: flags.session ?? (flags.agent && flags.agent !== base?.agent ? undefined : base?.tmuxSession),
});

const prompt =
  words.join(' ') || '연결 확인용이다. 도구를 쓰지 말고 "pong" 한 단어로만 답해라.';

const session = new AgentSession(sessionOptions(route));
await session.start();

console.log(`[라우트] ${session.key} — ${session.agentName}`);
console.log(`[tmux]   ${session.tmuxSession} / ${session.cwd}`);
console.log(`[실행]   ${session.launchCommand}`);
console.log(`[완료판정] ${session.agent.completion}`);
console.log(`[보냄]   ${prompt}\n`);

const startedAt = Date.now();
try {
  const result = await session.runTurn(prompt, { log: (m) => console.log(`[turn] ${m}`) });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[받음] (${seconds}초, turn ${result.turnId})\n${'-'.repeat(60)}`);
  console.log(result.message || '(답변 본문이 비어 있다)');
  console.log('-'.repeat(60));
  process.exit(result.message ? 0 : 1);
} catch (err) {
  console.error(`\n[실패] ${err.message}`);
  console.error('\n지금 화면:\n' + (await session.snapshot(30)));
  process.exit(1);
} finally {
  session.stop();
}
