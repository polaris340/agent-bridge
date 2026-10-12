# agent-bridge

> 📢 **고지**: 이 저장소의 코드와 문서는 전부 Claude(Anthropic 의 AI)가 작성했고,
> 사람이 검토하지 않았다. 동작·보안을 보증하지 않는다. 직접 읽어 보고 자기 책임으로
> 써라 ([MIT 라이선스](LICENSE), 보증 없음).

채팅에 쓴 글을 **tmux 에 상주하는 CLI 코딩 에이전트**로 넣고, 그 턴이 끝나면 답변을
채팅으로 돌려주는 브리지. 에이전트도 커넥터도 갈아끼울 수 있다.

```
디스코드 메시지
   └─► 라우터 ─┬─► [tmux: codex-my-game]         codex   (계속 살아 있음)
               ├─► [tmux: claude-my-app-5122]   claude
               └─► [tmux: claude-workspace-8801] claude
                        │
             완료 감지 (어댑터가 정한다)
                        ▼
                 디스코드로 답장
```

에이전트를 "띄우고 / 프롬프트를 넣고 / 턴이 끝날 때까지 기다리는" 절차는 공통이고,
**완료를 어떻게 아는지만** 어댑터가 정한다.

> ⚠️ **보안**: 부를 수 있는 사람은 채팅 메시지 하나로 이 컴퓨터에서 에이전트가 명령을
> 실행하게 할 수 있다. `ALLOWED_USER_IDS` 를 반드시 채우고 믿을 수 있는 사람만 넣어라.
> 처음 세우는 순서는 [SETUP_FOR_CLAUDE.md](SETUP_FOR_CLAUDE.md) 에 있다.

## 붙어 있는 에이전트

| 에이전트 | 완료 감지 | 정확도 |
| --- | --- | --- |
| `codex` | rollout jsonl 의 `task_complete`. 답변 전문이 이벤트에 들어 있다 | 정확 |
| `claude` | 세션 jsonl 이 `text` 로 끝난 뒤 조용해지면 완료 | 정확 |
| 그 밖의 아무 CLI | 화면이 조용해지면 완료 (`generic`) | 근사치 |

모르는 이름을 쓰면 그 이름을 실행 파일로 삼아 `generic` 으로 붙는다.
`opencode`, `aider`, `gemini` 같은 것들이 여기 해당한다.

### 왜 화면을 긁지 않는가

codex 는 TUI 세션도 `$CODEX_HOME/sessions/**/rollout-*.jsonl` 에 기록하고, 그 안에
`task_complete` 이벤트가 있다. `last_agent_message` 에 최종 답변 **전문**이 들어
있어서 완료 시점도 본문도 추측할 필요가 없다.

claude 는 그런 종료 이벤트가 없다. 최종 응답까지 전부 `stop_reason:"tool_use"` 로
찍힌다. 대신 세션 jsonl 의 모양으로 경계를 잡는다.

- **턴 시작** : `type:"user"` 이면서 `message.content` 가 문자열
  (도구 결과는 content 가 배열이라 사람이 친 입력과 구분된다)
- **턴 종료** : 마지막 assistant 가 `text` 를 냈고 뒤따르는 `tool_use` 가 없는
  상태로 파일이 `IDLE_MS` 동안 조용하면 완료

**`tool_use` 로 끝난 상태에서는 아무리 오래 조용해도 완료로 보지 않는다.** 도구가
오래 걸릴 때 답을 반쪽으로 끊어 보내는 오탐을 막는 장치다.

화면(`capture-pane`)은 `!pane`, 실패 진단, 그리고 "입력창이 떴는지" 확인에만 쓴다.

### 남의 세션과 섞이지 않게

같은 폴더에서 사람이 직접 에이전트를 돌리면 로그가 섞인다. claude 는 한 폴더에
세션 파일이 수십 개씩 쌓여서 "가장 최근 파일" 로 고르면 남의 대화를 읽는다.

- **claude** : 봇이 UUID 를 정해 `--session-id` 로 띄우고 그 파일만 본다
- **codex** : 새 세션의 id 를 지정하는 옵션이 없다. 대신 띄운 시각 이후에 시작된
  세션을 한 번 잡은 뒤 그 `session_id` 를 기억하고, 그 뒤로는 그 세션만 본다

어느 쪽이든 결과는 같다. 봇은 자기가 띄운 세션만 읽는다. 인스턴스 정보는 `.spool/`
에 남기므로 봇만 재시작해도 tmux 안의 에이전트를 이어 쓴다.

## 준비

### 1. 디스코드 봇 만들기

1. https://discord.com/developers/applications → **New Application**
2. 좌측 **Bot** → **Reset Token** → 토큰 복사 (`.env` 의 `DISCORD_TOKEN`)
3. 같은 화면에서 **MESSAGE CONTENT INTENT** 를 **켠다**. 이게 꺼져 있으면 메시지
   본문이 빈 문자열로 와서 봇이 아무 반응도 안 한다
4. 개인 도구라면 **Public Bot** 은 꺼 둔다. 끄려면 Installation 탭의 설치 링크를
   먼저 `None` 으로 바꿔야 한다
5. 좌측 **OAuth2 → URL Generator** 에서 Scopes `bot`, 권한은 `View Channel`,
   `Send Messages`, `Send Messages in Threads`, `Read Message History`,
   `Attach Files`, `Add Reactions`. 만들어진 URL 로 내 서버에 초대

### 2. 설정

```sh
cp .env.example .env
$EDITOR .env          # DISCORD_TOKEN 은 필수
npm install
npm run doctor        # 실행파일·폴더·tmux·로그 파서까지 점검
```

허용 범위(채널·서버·사람)가 정해지지 않은 라우트가 하나라도 있으면 봇은 뜨지 않는다.
채팅에 쓴 글이 곧 에이전트에 대한 지시가 되므로, 범위를 좁게 두는 게 실질적인 방어선이다.
서버 단위로 열더라도 `ALLOWED_USER_IDS` 는 채워 두는 게 좋다.

| 설정 | 뜻 |
| --- | --- |
| `ALLOWED_GUILD_IDS` | 이 서버 안이면 어느 채널에서든 쓸 수 있다 |
| `ALLOWED_CHANNEL_IDS` | 이 채널들은 따로 라우트를 갖는다 (고정 세션) |
| `ALLOWED_USER_IDS` | 부를 수 있는 사람. 비우면 위 범위의 모든 사람 |
| `AGENT` / `AGENT_CWD` | 위 채널들이 쓸 에이전트와 폴더 |
| `NEW_SESSION_AGENT` / `NEW_SESSION_CWD` | 그 밖의 채널·스레드가 쓸 에이전트와 폴더 |
| `PROJECT_ROOTS` | `!project` 로 고를 수 있는 폴더의 루트 (하위를 자동 등록) |
| `REQUIRE_MENTION` | 멘션한 글에만 반응 (기본 켜짐) |
| `STREAM_PROGRESS` | 작업 도중 설명도 채널로 보낸다 (기본 켜짐) |
| `TURN_TIMEOUT_MS` | 한 턴의 제한. `0` 이면 무제한 (기본) |
| `THREAD_IDLE_MS` | 이만큼 조용하면 tmux 를 내린다 (기본 30분, `.env.example` 은 6시간) |
| `CLAUDE_REMOTE_CONTROL` | `true` 면 claude 세션을 Remote Control 로도 연다 (기본 꺼짐) |

채널마다 에이전트·폴더를 아예 다르게 두려면 `routes.json` 을 만든다
(`routes.example.json` 참고). 그 파일이 있으면 위 라우트 설정은 무시된다.

## 실행

```sh
npm start                                          # 봇 상주
npm run doctor                                     # 설정 점검
npm test                                           # 라우팅 규칙 검증
npm run selftest                                   # 커넥터 없이 왕복 한 번
npm run selftest -- --agent claude --cwd /path "안녕"
```

에이전트가 도는 tmux 세션은 직접 볼 수 있다.

```sh
tmux ls
tmux attach -t claude-my-app-5122     # 빠져나올 땐 Ctrl-b d
```

### 다시 띄우기

```sh
tools/restart.sh          # 내리고 다시 띄운다 (작업 중인 판은 미리 알려준다)
tail -f agent-bridge.log  # 로그 (AGENT_BRIDGE_LOG 로 위치를 바꿀 수 있다)
```

🔴 **macOS 에서는 터미널에서 띄운다.** launchd 로 로그인할 때 자동으로 뜨게 하면, 그렇게
띄운 tmux 판은 맥이 `~/Documents` 접근을 막는다(EPERM, 묻지도 않고 거부). 작업 폴더가
거기 있으면 그대로는 못 쓴다. 자동 시작을 붙이려면 tmux 에 전체 디스크 접근 권한을
먼저 줘야 한다.

**봇은 한 번에 하나만 돌려라.** 둘이 동시에 돌면 같은 tmux 세션에 각자 키를 밀어
넣어서 셸 한 줄에 실행 명령이 두 번 겹쳐 들어가고, 그 뒤 채팅에 쓴 글이 에이전트가
아니라 셸로 떨어진다. `.spool/bot.lock` 으로 막아 두었다.

## 채널에서 쓰는 법

허용된 곳에서 **봇을 멘션하면** 그 채널의 에이전트로 들어간다
(`@봇이름 이 파일 좀 봐줘`). 멘션 없는 글은 무시하므로 사람끼리 나누는 대화에
끼어들지 않는다. 명령도 `@봇이름 !status` 처럼 부른다. DM 은 멘션할 수가 없으니
그냥 쓰면 된다.

```
[내 메시지]  👀                     ← 봤다

> 파일 구조부터 확인할게요           ← 작업 도중의 설명 (인용)
> 세 군데 고치면 되겠습니다

수정 끝냈습니다. router.js 에서...   ← 최종 답변
✅                                  ← 여기까지가 이번 턴
```

눈알은 답이 나가기 시작하면 뗀다. 실패하면 눈알을 떼고 사유 한 줄만 남긴다.

**에이전트가 보여주려는 파일은 채널로 올라온다.** claude 는 SendUserFile 로 보내겠다고
지목한 것을, codex 는 내장 그림 도구로 만든 그림(`generated_images`)을 올린다. 답변에
경로를 적은 그림·영상·소리도 같이 올린다. 터미널 CLI 에는 채팅으로 파일을 보낼 통로가
없어서 봇이 대신 올려 주는 것이다.

올리는 자리는 좁게 둔다. 작업 폴더, `/tmp`, 에이전트가 그림을 두는 자리 안의 파일만
올리고, 링크는 끝까지 풀어서 실제 위치로 따진다. 그 안이라도 점으로 시작하는 파일
(`.env` …)과 `.ssh` `.git` `.aws` 같은 폴더 아래는 올리지 않는다. 에이전트는 읽은 문서
속 지시에 넘어갈 수 있어서, "이 파일 보내" 를 그대로 믿지 않는다.

**파일과 이미지도 붙여 보낼 수 있다.** 받아서 `.spool/files/` 에 두고 그 경로를
프롬프트에 실어 보낸다. 에이전트가 알아서 읽는다. 글 없이 파일만 던져도 된다.
받아 둔 파일은 하루 지나면 치운다.

**답을 기다리는 중에도 그냥 보내면 된다.** 에이전트가 작업 중에 들어온 입력을 알아서
반영하므로(steering) 붙잡아 두지 않는다. 그렇게 한 턴에 묶인 메시지들은 **답장을 한
번만** 받는다(마지막 메시지에 달린다). 같은 답이 보낸 횟수만큼 나가지 않게 하려는
것이다.

### 채널과 스레드

| 상황 | 어떻게 되나 |
| --- | --- |
| 서버 안 아무 채널 | 채널마다 세션이 따로 뜬다 |
| 스레드를 연다 | 스레드마다 세션이 따로 뜬다 |
| `ALLOWED_CHANNEL_IDS` 에 적은 채널 | 그 라우트의 고정 세션을 쓴다 |

채널도 스레드도 보통 작업 하나의 단위라 각자 에이전트를 따로 띄운다. 서로 기다리지
않고 맥락도 안 섞인다. 한 세션으로 묶고 싶으면 라우트에 `"perChannel": false` 나
`"perThread": false` 를 준다.

tmux 이름은 `<에이전트>-<폴더>-<채널id 끝 네 자리>` 로 짓는다
(`claude-my-app-5122`). `tmux ls` 만 보고도 뭐가 어디서 도는지 알 수 있게.

### 조용해지면 내리고, 다시 부르면 이어간다

`THREAD_IDLE_MS`(기본 30분) 동안 조용하면 tmux 를 내린다. 안 그러면 채널을 열 때마다
tmux 세션과 에이전트 프로세스가 쌓이기만 한다.

**내려도 하던 얘기는 남는다.** 대화 기록은 에이전트가 자기 폴더에 쌓아 두고, 봇은 그
세션 id 를 적어 둔다. 다시 말을 걸면 그 대화를 이어서 띄운다
(`claude --resume <id>` / `codex resume <id> --cd <폴더>`). 이어 붙이기가 실패할
때만 새로 시작한다.

기록까지 버리는 건 폴더를 옮길 때(`!project`)와 `!restart` 뿐이다.
작업 중인 세션은 내리지 않고, 고정 채널 세션은 자동으로 내리지 않는다.

### 명령

| 명령 | 하는 일 |
| --- | --- |
| `!help` | 도움말 |
| `!project` (`!cd`) | 쓸 수 있는 폴더 목록 |
| `!project <이름>` | 이 채널을 그 폴더로 옮긴다. **없는 이름이면 새로 만든다** |
| `!agent` | 지금 에이전트와 고를 수 있는 이름 |
| `!agent <이름>` | 에이전트를 바꾼다. 어댑터가 있는 것(`codex` `claude` `sonnet`)과 라우트에 적힌 것만 된다. claude ↔ sonnet 은 대화가 이어진다 |
| `!status` | 에이전트·폴더·tmux·보고 있는 로그·작업 여부 |
| `!agents` | 떠 있는 세션 전부 |
| `!pane` | 지금 화면 마지막 40줄 |
| `!esc` (`!cancel`) | 진행 중인 턴 중단 |
| `!restart` | 처음부터 다시 띄운다. **하던 얘기를 버린다** |

명령은 큐를 거치지 않아 작업 중에도 바로 답한다.

`!project` 로 고를 수 있는 폴더는 `PROJECT_ROOTS` 아래를 훑어 자동 등록하고,
`PROJECTS` 로 하나씩 더 적을 수 있다. 없는 이름을 부르면 `PROJECT_ROOTS` 의 첫 루트
아래에 만들고 `git init` 까지 한다. 이름은 영숫자와 `.` `_` `-` 만 받는다.
경로를 벗어나는 이름을 막기 위한 것이다. 한 번 고른 폴더는 그 채널이 기억하므로
세션을 내렸다 다시 띄워도 그 폴더에서 뜬다.

## 알아둘 것

**입력은 두 군데서 조용히 실패한다.** TUI 가 막 떴을 때는 입력을 아예 못 받고,
붙여넣기 직후 Enter 는 씹힌다. 그래서 입력창이 실제로 그려진 걸 확인한 뒤에 보내고,
붙여넣은 게 화면에 보이는지 보고, Enter 는 `ENTER_DELAY_MS` 뒤에 친다. 그래도 턴이
시작되지 않으면 Enter 를 한 번 더 보낸다.

**처음 여는 폴더에서는 에이전트가 신뢰 여부를 먼저 묻는다.** 여기 걸린 줄 모르고
프롬프트를 밀어 넣으면 그 지시가 통째로 유실된다. 그 화면을 감지해 넘기고 로그에
남긴다.

**줄바꿈이 섞이거나 긴 메시지는 파일로 넘어간다.** tmux 로 줄바꿈을 그대로
붙여넣으면 TUI 가 중간에서 Enter 로 받아 지시가 토막 난다. 그래서 그런 메시지는
`.spool/` 에 파일로 쓰고 "이 파일을 읽고 처리해라" 로 바꿔 보낸다. 이 파일들은
하루 지나면 알아서 치운다.

**턴에 제한 시간이 없다** (`TURN_TIMEOUT_MS=0`). 제한을 걸어 두면 아직 일하고 있는
에이전트를 실패로 만들 뿐이다. 제한을 걸었더라도, 그 뒤에 늦게 끝난 작업의 답은
그 채널로 흘려보낸다.

**PATH 에서 못 찾으면 실행 파일을 실경로로 적어라.** 봇이 띄운 셸의 PATH 가 터미널과
다를 수 있다. 터미널에 따라서는(cmux 등) `which codex` 가 곧 사라지는 임시 shim 을
가리키기도 한다.

**승인 모드는 에이전트 쪽 설정을 그대로 따른다.** 봇은 샌드박스를 따로 지정하지
않는다. 도구 승인 프롬프트가 뜨면 턴이 거기서 멈추므로, 필요하면 라우트의
`command` 에 해당 플래그를 넣어라 (`"codex --yolo"`). 경로에 띄어쓰기가 있으면
배열로 적는다 (`["/My Tools/codex", "--yolo"]`).

**봇을 재시작해도 에이전트는 tmux 안에서 계속 돈다.** 다시 뜬 봇이 돌던 판에 붙고, 그
사이 끝난 답은 `⌛ 늦게 끝났다` 로 올라온다. 다만 봇이 꺼져 있던 몇 초 사이에 끝난
답은 놓친다. 그럴 땐 `!pane` 이나 `tmux attach` 로 본다.

### generic 어댑터의 한계

로그 규격이 없는 TUI 는 화면이 조용해지는 것으로 완료를 판정한다.

- **답변에 화면 부스러기가 섞인다.** 상태줄(`Build · 1m 24s`, 토큰 수 등)은 글자가
  있어서 장식 필터로 걸러지지 않는다
- **판정이 근사치다.** 에이전트가 오래 뜸을 들이면 그 사이를 완료로 볼 수 있다

자주 쓰는 에이전트라면 전용 어댑터를 붙이는 게 낫다. 로그를 읽어 완료를 아는 예시는
`src/agents/codex.js`, 화면만 보는 가장 단순한 예시는 `src/agents/generic.js` 다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `src/index.js` | 조립. 커넥터에서 온 메시지를 라우터에 넘기고 명령을 처리 |
| `src/routing.js` | "이 메시지는 어느 세션으로 가는가" 만 정하는 순수 함수 |
| `src/routing.test.js` | 라우팅 규칙 검증 |
| `src/router.js` | 채널·스레드를 세션에 붙이고, 조용해진 세션을 내린다 |
| `src/session.js` | tmux 세션 하나 = 에이전트 하나. 띄우기·주입·턴 대기·이어 붙이기 |
| `src/tmux.js` | 세션 보장, 키 전송(+입력 확인), pane 캡처 |
| `src/lock.js` | 봇이 둘 이상 돌지 못하게 |
| `src/agents/` | 완료를 어떻게 아는지 (codex / claude / generic) |
| `src/connectors/` | 어디서 말이 오는지 (지금은 discord) |
| `src/watchers/jsonl-tail.js` | JSONL 세션 로그 tailing (파일 전환·UTF-8 경계 처리) |
| `src/config.js` | 라우트·프로젝트·허용 범위 |
| `src/doctor.js` | 설정·실행파일·tmux·로그 파서 점검 |
| `src/selftest.js` | 커넥터 없이 왕복 1회 |

## 커넥터 늘리기

`src/connectors/discord.js` 가 지키는 약속은 이게 전부다.

```js
new Connector({ token, onMessage })
await connector.start()
await connector.send(channelId, text)   // 먼저 말 걸 때
await connector.stop()

// onMessage 로 넘기는 것
// { channelId, parentId, guildId, mentioned, isDirect,
//   userId, userName, text, reply, react, unreact }
```

슬랙이든 텔레그램이든 이 모양만 맞춰 `src/connectors/index.js` 에 등록하면
나머지(라우팅·세션·에이전트)는 그대로 쓴다.

## 라이선스

[MIT](LICENSE)
