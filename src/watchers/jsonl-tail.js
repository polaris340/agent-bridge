import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

/** 디렉토리를 훑어 조건에 맞는 파일을 mtime 최신순으로 돌려준다. */
export async function findFiles(root, matches) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && matches(entry.name)) {
        try {
          const st = await fsp.stat(full);
          found.push({ file: full, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, size: st.size });
        } catch {
          /* 지워졌으면 넘어간다 */
        }
      }
    }
  }
  await walk(root);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function readFirstLine(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) return line;
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function readJsonlRecords(file) {
  const records = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* 쓰는 중인 줄일 수 있다 */
    }
  }
  return records;
}

/**
 * 에이전트가 남기는 JSONL 세션 로그를 따라가며 레코드를 흘려보낸다.
 *
 * 어느 파일을 볼지(`locate`)와 레코드를 어떻게 해석할지(`handleRecord`)만
 * 에이전트별로 갈아끼우면 된다. 파일 전환·부분 줄·UTF-8 경계 처리는 여기서 한다.
 *
 * events: 'file-switched' { file }, 'error' Error
 *         (그 밖의 이벤트는 handleRecord 안에서 emit 한다)
 */
export class JsonlTailWatcher extends EventEmitter {
  #locate;
  #handleRecord;
  #pollMs;
  #rescanMs;
  #pollTimer = null;
  #rescanTimer = null;
  #active = null; // { file, offset, pending: Buffer }
  #draining = false;

  /**
   * @param {object} opts
   * @param {() => Promise<{file:string,size:number}|null>} opts.locate 현재 봐야 할 파일
   * @param {(record:object, watcher:JsonlTailWatcher) => void} opts.handleRecord
   */
  constructor({ locate, handleRecord, pollMs = 700, rescanMs = 4000 }) {
    super();
    this.#locate = locate;
    this.#handleRecord = handleRecord;
    this.#pollMs = pollMs;
    this.#rescanMs = rescanMs;
  }

  get activeFile() {
    return this.#active?.file ?? null;
  }

  /** 시작 시점에 이미 쌓여 있던 내용은 건너뛴다. 과거 답변이 쏟아지면 안 된다. */
  async start() {
    const target = await this.#locate();
    if (target) {
      this.#active = { file: target.file, offset: target.size, pending: Buffer.alloc(0) };
    }
    this.#pollTimer = setInterval(() => void this.#drain(), this.#pollMs);
    this.#rescanTimer = setInterval(() => void this.#rescan(), this.#rescanMs);
  }

  stop() {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#rescanTimer) clearInterval(this.#rescanTimer);
    this.#pollTimer = null;
    this.#rescanTimer = null;
  }

  /** 에이전트 안에서 새 세션이 열리면 파일이 갈린다. 새 파일은 처음부터 읽는다. */
  async #rescan() {
    try {
      const target = await this.#locate();
      if (!target || this.#active?.file === target.file) return;

      // 방금 생긴 파일이면 처음부터 읽고, 원래 있던 파일로 옮겨 간 거면 끝에서부터
      // 읽는다. 무턱대고 처음부터 읽으면 그 파일에 쌓여 있던 과거 턴이 전부 완료로
      // 잡혀서 옛 답장이 채널로 줄줄이 다시 나간다.
      const born = target.birthtimeMs ?? 0;
      const isNew = born > 0 && Date.now() - born < 60_000;
      this.#active = { file: target.file, offset: isNew ? 0 : target.size, pending: Buffer.alloc(0) };
      this.emit('file-switched', { file: target.file, fromStart: isNew });
    } catch (err) {
      this.emit('error', err);
    }
  }

  async #drain() {
    if (this.#draining || !this.#active) return;
    this.#draining = true;
    try {
      const active = this.#active;
      let st;
      try {
        st = await fsp.stat(active.file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        // 보던 파일이 없어졌다. 붙잡고 있어 봐야 아무 일도 안 일어난다.
        // 놓아주면 다음 rescan 이 지금 쓰이는 파일을 다시 찾는다.
        console.log(`[jsonl] 보던 파일이 사라져 다시 찾는다: ${active.file}`);
        this.#active = null;
        return;
      }
      if (st.size < active.offset) {
        active.offset = 0;
        active.pending = Buffer.alloc(0);
      }
      if (st.size === active.offset) return;

      const length = st.size - active.offset;
      const buf = Buffer.alloc(length);
      const fh = await fsp.open(active.file, 'r');
      let bytesRead = 0;
      try {
        ({ bytesRead } = await fh.read(buf, 0, length, active.offset));
      } finally {
        await fh.close();
      }
      active.offset += bytesRead;

      // UTF-8 문자가 읽기 경계에 걸릴 수 있다. 마지막 개행까지만 문자열로 바꾸고
      // 나머지는 바이트인 채로 다음 회차에 넘긴다 (한글 답변이 깨지지 않게).
      active.pending = Buffer.concat([active.pending, buf.subarray(0, bytesRead)]);
      const lastNewline = active.pending.lastIndexOf(0x0a);
      if (lastNewline < 0) return;

      const text = active.pending.subarray(0, lastNewline).toString('utf8');
      active.pending = active.pending.subarray(lastNewline + 1);

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          this.#handleRecord(record, this);
        } catch (err) {
          this.emit('error', err);
        }
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.#draining = false;
    }
  }
}
