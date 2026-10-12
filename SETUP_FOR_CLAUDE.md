# agent-bridge 설치 안내 (Claude 에게 주는 문서)

이 문서는 **이 폴더를 받은 사람의 Claude(Claude Code)** 가 읽고 따라 하라고 쓴 것이다.
사람이 직접 해야 하는 단계는 🙋 로 표시했다. 그 단계에서는 멈추고 사람에게 부탁해라.

## 이게 뭔가

디스코드 채널에서 봇을 멘션하면, 이 맥에서 tmux 안에 상주하는 코딩 에이전트
(codex CLI, Claude Code CLI)에게 그 말을 그대로 넣어 주고, 답이 나오면 채널로 돌려준다.

- 채널마다 세션이 따로 뜬다. 채널마다 작업 폴더(`!project`)와 에이전트(`!agent`)를 고를 수 있다.
- 작업 도중 들어온 말은 막지 않고 바로 넣는다(에이전트가 알아서 반영한다).
- 답에 그림·영상·소리 파일 경로가 있으면 파일을 같이 올린다.
- 조용한 세션은 6시간(`.env.example` 기준) 뒤 내린다. 내려도 대화는 남아서 다시 부르면 이어서 뜬다.

자세한 구조와 설정은 `README.md` 에 있다. 이 문서는 **새 맥에 처음 세우는 순서**와
**실제로 겪은 함정**만 다룬다.

🔴 **보안**: 허용된 사람은 디스코드 메시지 하나로 이 맥에서 에이전트가 명령을 실행하게
할 수 있다. `ALLOWED_USER_IDS` 를 반드시 채우고, 믿을 수 있는 사람만 넣어라.

---

## 1. 준비물 (macOS 기준으로 만들고 검증했다)

```sh
brew install node tmux          # node 20 이상 (22 에서 검증)
node --version && tmux -V
```

쓸 에이전트 CLI 를 깔고 **로그인까지** 해 둔다. 둘 중 하나만 써도 된다.

```sh
# Claude Code
npm install -g @anthropic-ai/claude-code   # 또는 공식 설치 방법
claude          # 🙋 처음 한 번 띄워서 로그인
# codex
brew install --cask codex
codex           # 🙋 처음 한 번 띄워서 로그인
```

## 2. 디스코드 봇 만들기 🙋

사람이 브라우저에서 해야 한다. Claude 는 순서만 안내해라.

1. https://discord.com/developers/applications → **New Application**
2. **Bot** 탭
   - **Reset Token** → 토큰 복사 (이걸 3단계 `.env` 에 넣는다. 채팅에 붙여 넣지 말 것)
   - **Privileged Gateway Intents** 에서 **MESSAGE CONTENT INTENT 를 켠다** (안 켜면 봇이 글을 못 읽는다)
   - **Public Bot** 은 끈다
3. **OAuth2 → URL Generator**
   - Scopes: `bot`
   - Bot Permissions: View Channels, Send Messages, Send Messages in Threads,
     Read Message History, Attach Files, Add Reactions
   - 생성된 URL 로 자기 서버에 초대한다
4. 디스코드 앱 설정 → 고급 → **개발자 모드** 를 켜고, 아래 ID 들을 우클릭 → "ID 복사" 로 모은다
   - 서버 ID, 쓸 사람들의 사용자 ID, (고정할 채널이 있으면) 채널 ID

## 3. 설치

이 폴더를 **`~/Documents` 바깥** 에 두는 걸 권한다(예: `~/workspace/agent-bridge`).
이유는 아래 함정 1번.

```sh
cd ~/workspace/agent-bridge
npm ci
cp .env.example .env
chmod 600 .env
```

`.env` 를 채운다. 꼭 채울 것:

| 키 | 값 |
|---|---|
| `DISCORD_TOKEN` | 2단계 토큰 🙋 (사람이 직접 붙여 넣게 해라) |
| `ALLOWED_GUILD_IDS` | 서버 ID — 이 서버 아무 채널에서나 쓸 수 있다 |
| `ALLOWED_USER_IDS` | 부를 수 있는 사람 ID, 쉼표 구분. 🔴 비우지 마라 |
| `NEW_SESSION_AGENT` | 새 채널이 쓸 에이전트: `claude` 또는 `codex` |
| `NEW_SESSION_CWD` | 새 채널이 시작할 폴더 |
| `PROJECT_ROOTS` | `!project <이름>` 으로 고를 수 있는 폴더들의 부모 |

특정 채널을 특정 폴더·에이전트에 고정하려면 `ALLOWED_CHANNEL_IDS` + `AGENT` + `AGENT_CWD`.
필요 없으면 `ALLOWED_CHANNEL_IDS` 를 비워 둔다. 나머지는 `.env.example` 주석 참고.

## 4. 확인하고 띄우기

```sh
npm test            # 전부 통과해야 한다 (tmux 가 있어야 하는 검사도 있다)
npm run doctor      # 설정·에이전트 점검
tools/restart.sh    # 봇을 띄운다 (이미 떠 있으면 내렸다 다시 띄운다)
tail -f agent-bridge.log
```

로그에 `[bot] 준비됐다.` 가 나오면 된 것이다. 디스코드에서 봇을 멘션해서 말을 걸어 본다.

⚠️ `npm test` 가 cmux 같은 터미널에서 `NODE_OPTIONS` preload 때문에 깨지면
`NODE_OPTIONS= npm test` 로 돌린다.

## 5. 채널에서 쓰는 명령

| 명령 | 하는 일 |
|---|---|
| `@봇 아무 말` | 에이전트에게 전달. 작업 중이면 바로 끼워 넣는다 |
| `!help` | 도움말 |
| `!status` | 이 채널 세션 상태 |
| `!project <이름>` | 작업 폴더 바꾸기 (없으면 만든다) |
| `!agent <claude\|codex\|sonnet>` | 에이전트 바꾸기. claude↔sonnet 은 대화가 이어진다 |
| `!agents` | 떠 있는 세션 전부 |
| `!pane` | 에이전트 화면 그대로 보기 |
| `!esc` | 지금 작업 중단 |
| `!restart` | 하던 대화를 버리고 새로 띄우기 |

에이전트 화면은 직접 볼 수도 있다: `tmux ls` → `tmux attach -t <이름>` (빠져나오기 `Ctrl-b d`).

---

## 실제로 겪은 함정 (먼저 읽어라)

대부분 코드에 대응이 들어가 있지만, 사람이 손대야 하는 것도 있다.

1. **launchd 로 자동 시작하지 마라.** launchd 가 띄운 프로세스(와 그 tmux)는 macOS 가
   `~/Documents` 접근을 묻지도 않고 막는다(`EPERM`). 작업 폴더가 거기 있으면 기록 저장·파일
   업로드가 조용히 죽는다. 터미널에서 `tools/restart.sh` 로 띄운다. 재부팅하면 다시 띄워야 한다.
2. **codex 를 새로 깔거나 업데이트한 직후** 맥이 바이너리를 처음 검사하느라 1~2분 멈춘다.
   이때 codex 가 `timed out negotiating with the code-mode host` 를 낸다. 기다리면 풀린다.
   계속 막히면 🙋 시스템 설정 → 개인정보 보호 및 보안 → 보안 에서 "그래도 허용".
3. **codex 대화를 다른 앱(ChatGPT 앱 등)에서 열면** 판 쪽이 잠긴다
   (`This conversation is open in another app … press R`). 다른 앱에서 닫고 판에서 `r`.
4. **codex 대화가 보관(archive)되면** `thread not found` 가 난다. `codex unarchive <id>` 후
   그 판을 내리면(`tmux kill-session -t <이름>`) 다음 메시지에 이어서 뜬다.
5. **Claude Code 가 처음 보는 폴더** 에서는 "이 폴더를 믿나" 창이 뜬다. 봇이 알아서 "Yes" 로
   넘긴다(기본 선택이 "No, exit" 라 그냥 Enter 를 치면 꺼진다 — 이미 대응됨).
6. **봇은 한 번에 하나만.** 둘이 돌면 같은 판에 키를 겹쳐 넣어 입력이 깨진다. `.spool/bot.lock` 이 막는다.
7. **봇을 재시작해도 에이전트 판은 안 죽는다.** 다시 뜬 봇이 돌던 판에 붙고, 그 사이 끝난 답은
   `⌛ 늦게 끝났다` 로 올라온다. 단, 봇이 꺼져 있던 몇 초 사이에 끝난 답은 놓친다.

## 넣지 않은 것

- `.env` (토큰·ID), `.spool/` (세션 기록·받은 파일), `node_modules/`, 로그는 저장소에 없다.
- 검사 코드 속 경로·이름(`/Users/me`, `alice` 등)은 예시다. 동작과는 무관하다.
