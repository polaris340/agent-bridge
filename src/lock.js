import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 봇은 한 번에 하나만 돌아야 한다.
 *
 * 둘이 동시에 돌면 같은 tmux 세션에 각자 키를 밀어 넣는다. 실제로 겪은 증상은
 * 셸 한 줄에 codex 실행 명령이 두 번 겹쳐 들어가 `--cd` 가 중복이라 죽고,
 * 그 뒤 채팅에 쓴 글이 codex 가 아니라 셸로 떨어지는 것이었다.
 */
const isAlive = (pid) => {
  try {
    process.kill(pid, 0); // 신호 0 은 존재 확인만 한다
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 남의 프로세스라도 살아 있는 건 맞다
  }
};

export async function acquireLock(dir) {
  const file = path.join(dir, 'bot.lock');

  let previous = null;
  try {
    previous = Number.parseInt(await fsp.readFile(file, 'utf8'), 10);
  } catch {
    /* 없으면 처음 뜨는 것이다 */
  }

  if (previous && previous !== process.pid && isAlive(previous)) {
    throw new Error(
      `이미 봇이 돌고 있다 (PID ${previous}).\n` +
        '둘이 같은 tmux 세션에 키를 밀어 넣으면 입력이 겹쳐 깨진다.\n' +
        `먼저 끄고 다시 시작해라:  kill ${previous}`,
    );
  }

  // .spool 에는 채팅으로 받은 지시·파일·세션 기록이 쌓인다. 다른 계정이 못 읽게 만든다.
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(file, String(process.pid), 'utf8');

  return async function release() {
    try {
      const owner = Number.parseInt(await fsp.readFile(file, 'utf8'), 10);
      if (owner === process.pid) await fsp.rm(file, { force: true });
    } catch {
      /* 이미 지워졌으면 그만이다 */
    }
  };
}
