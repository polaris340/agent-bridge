import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // 디스코드가 받아주는 한도
// 채널에 바로 보이거나 들리는 것들. 소리도 넣는다 — 디스코드는 mp3·wav 를 재생기로 띄운다.
const MEDIA_EXTS = 'png|jpe?g|gif|webp|bmp|svg|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|oga|flac|aac|opus';
const MEDIA_EXT = new RegExp(`\\.(${MEDIA_EXTS})$`, 'i');

/**
 * 올려도 되는 자리.
 *
 * 작업 폴더 안이면 당연히 되고, /tmp 도 연다. 스크린샷과 중간 산출물은 대개 거기
 * 떨어지는데, 작업 폴더만 보다가 그런 그림을 통째로 놓쳤다. 맥은 /tmp 가
 * /private/tmp 를 가리키는 링크라 둘 다 적어 둔다.
 *
 * os.tmpdir()(/var/folders/…) 은 열지 않는다. 온갖 프로그램의 임시 파일이 섞여 있는
 * 자리라, 에이전트가 경로를 한 줄 말했다고 그 안을 통째로 여는 건 과하다.
 *
 * 에이전트가 자기 그림을 따로 두는 자리는 어댑터가 extraRoots 로 알려 준다.
 */
const TEMP_ROOTS = ['/tmp', '/private/tmp'];

const within = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);

const realOrSelf = (file) => fsp.realpath(file).catch(() => file);

/** 허용된 자리 안이라도 이런 폴더 아래는 내보내지 않는다. 키·인증 정보가 사는 곳이다. */
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config', '.git', '.spool', '.codex', '.claude']);

/**
 * 올려도 되는 파일인지 보고, 되면 stat 을 돌려준다.
 *
 * 경로 글자만 보면 안 된다. 작업 폴더 안의 shot.png 가 ~/.ssh/id_rsa 를 가리키는 링크면
 * 글자로는 작업 폴더 안이지만 실제로는 키가 나간다. 링크를 다 푼 실제 경로로 본다.
 * 점으로 시작하는 파일(.env …)과 SECRET_DIRS 아래도 막는다. 점 폴더를 통째로 막지는
 * 않는다 — .worktrees 아래 결과물처럼 정당하게 올리는 것이 있다.
 */
async function uploadable(file, cwd, { extraRoots = [], tempRoots = TEMP_ROOTS } = {}) {
  const real = await fsp.realpath(file).catch(() => null);
  if (!real) return null;
  const roots = await Promise.all([cwd, ...tempRoots, ...extraRoots].map(realOrSelf));
  const root = roots.find((dir) => within(real, dir));
  if (!root) return null;
  const parts = path.relative(root, real).split(path.sep);
  if (parts.at(-1).startsWith('.') || parts.some((part) => SECRET_DIRS.has(part))) return null;
  const stat = await fsp.stat(real).catch(() => null);
  return stat?.isFile() && stat.size > 0 ? stat : null;
}

/**
 * 글에서 파일 경로를 뽑는다.
 *
 * 마크다운 링크 [설명](경로) 는 괄호 안을 통째로 경로로 본다. 경로에 띄어쓰기가 있어도
 * 된다 — "Tentative Images/EV-001_2.png" 처럼 폴더 이름에 공백이 있으면, 글자 단위로만
 * 찾을 때 "Images/EV-001_2.png" 만 잡혀 엉뚱한 경로가 됐다(10-10).
 * <경로> 로 감싼 것과 %20 같은 인코딩도 푼다. 링크가 아닌 맨 글자 경로는 예전처럼 찾는다.
 */
function mentionedPaths(text) {
  const out = [];
  const link = /\]\(\s*<?([^)<>]+?)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const match of text.matchAll(link)) {
    let target = match[1].trim();
    if (/^https?:/i.test(target)) continue;
    target = target.replace(/^file:\/\//, '');
    try {
      target = decodeURIComponent(target);
    } catch {
      /* 인코딩이 아니면 그대로 */
    }
    if (MEDIA_EXT.test(target)) out.push(target);
  }
  const bare = new RegExp(`[\\w./~-]*\\.(?:${MEDIA_EXTS})\\b`, 'gi');
  out.push(...(text.replace(link, ' ').match(bare) ?? []));
  return out;
}

/**
 * 답변에 나온 그림 파일을 찾아 함께 올린다.
 *
 * 에이전트는 "이미지를 만들었다" 며 경로만 말한다. 채팅에서는 그 경로를 열어볼 수가
 * 없으니 파일을 같이 보내야 의미가 있다. 다만 아무 경로나 빨아들이면 엉뚱한 파일이
 * 나가므로 작업 폴더 안에 실제로 있는 그림만 고른다.
 */
export async function collectImages(text, cwd, places = {}) {
  if (!text) return { files: [], tooBig: [] };

  const found = new Set();
  const tooBig = [];
  for (const raw of mentionedPaths(text)) {
    const cleaned = raw.replace(/^[`'"(]+/, '');
    const file = path.resolve(cwd, cleaned.startsWith('~/') ? cleaned.replace('~', process.env.HOME ?? '~') : cleaned);
    if (!MEDIA_EXT.test(file)) continue;

    // 작업 폴더와 임시 폴더 밖은 올리지 않는다.
    const stat = await uploadable(file, cwd, places);
    if (!stat) continue;
    if (stat.size > MAX_UPLOAD_BYTES) {
      tooBig.push({ file, size: stat.size });
      continue;
    }
    found.add(file);
    if (found.size >= 5) break;
  }
  return { files: [...found], tooBig };
}

/** 로그에 base64 로 담겨 온 그림을 파일로 떨군다. */
export async function saveInlineImages(images = [], dir) {
  if (images.length === 0) return [];
  await fsp.mkdir(dir, { recursive: true });

  const saved = [];
  for (const [index, image] of images.entries()) {
    const ext = (image.mediaType ?? '').includes('jpeg') ? 'jpg' : (image.mediaType ?? '').split('/')[1] || 'png';
    const file = path.join(dir, `seen-${Date.now()}-${index}.${ext}`);
    try {
      const buffer = Buffer.from(image.data, 'base64');
      if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) continue;
      await fsp.writeFile(file, buffer);
      saved.push(file);
    } catch {
      /* 못 쓰면 그냥 넘어간다 */
    }
  }
  return saved;
}

/**
 * 에이전트가 보내겠다고 한 경로를 실제 파일로 푼다.
 * 상대경로는 작업 폴더 기준이고, 없는 파일과 너무 큰 것은 뺀다.
 *
 * 그림이 아니어도 보내지만 자리는 답변 속 그림과 똑같이 따진다. 에이전트가 보내겠다고
 * 한 것이라도 ~/.ssh 나 .env 를 채널에 올리게 둘 수는 없다 — 에이전트는 읽은 문서 속
 * 지시에 넘어갈 수 있다.
 */
export async function resolveSentFiles(paths = [], cwd, places = {}) {
  const out = [];
  const tooBig = [];
  for (const raw of paths) {
    const expanded = raw.startsWith('~/') ? raw.replace('~', process.env.HOME ?? '~') : raw;
    const file = path.resolve(cwd, expanded);
    const stat = await uploadable(file, cwd, places);
    if (!stat) continue;
    if (stat.size > MAX_UPLOAD_BYTES) {
      tooBig.push({ file, size: stat.size });
      continue;
    }
    out.push(file);
    if (out.length >= 5) break;
  }
  return { files: out, tooBig };
}

/** 너무 커서 못 올린 것을 사람이 읽을 한 줄로. */
export function describeTooBig(list = []) {
  if (list.length === 0) return '';
  const mb = (n) => `${(n / 1048576).toFixed(0)}MB`;
  const limit = mb(MAX_UPLOAD_BYTES);
  return list
    .map((item) => `⚠️ \`${item.file}\` 는 ${mb(item.size)} 라 못 올렸다 (한도 ${limit}).`)
    .join('\n');
}
