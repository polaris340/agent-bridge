import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectImages, describeTooBig, resolveSentFiles } from './images.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgtest-'));
// 리눅스는 os.tmpdir() 가 /tmp 라서, /tmp 를 열어 둔 채로는 "작업 폴더 밖" 을 만들 수 없다.
const noTmp = { tempRoots: [] };
const cwd = path.join(root, 'project');
await fsp.mkdir(path.join(cwd, 'shots'), { recursive: true });

const png = Buffer.from('89504e470d0a1a0a', 'hex');
await fsp.writeFile(path.join(cwd, 'shots', 'preview.png'), png);
await fsp.writeFile(path.join(cwd, 'diagram.jpg'), png);
await fsp.writeFile(path.join(root, 'outside.png'), png);
await fsp.writeFile(path.join(cwd, 'empty.png'), '');

test('작업 폴더 안의 그림을 절대경로로 찾는다', async () => {
  const got = (await collectImages(`만들었다: ${cwd}/shots/preview.png`, cwd)).files;
  assert.deepEqual(got, [path.join(cwd, 'shots', 'preview.png')]);
});

test('상대경로와 백틱도 알아본다', async () => {
  const got = (await collectImages('결과는 `shots/preview.png` 를 봐라', cwd)).files;
  assert.deepEqual(got, [path.join(cwd, 'shots', 'preview.png')]);
});

test('작업 폴더 밖은 올리지 않는다', async () => {
  const got = (await collectImages(`저장했다: ${path.join(root, 'outside.png')}`, cwd, noTmp)).files;
  assert.deepEqual(got, []);
});

test('경로를 거슬러 올라가는 것도 막는다', async () => {
  const got = (await collectImages('../outside.png 확인해라', cwd, noTmp)).files;
  assert.deepEqual(got, []);
});

test('없는 파일은 무시한다', async () => {
  const got = (await collectImages('missing.png 를 만들었다', cwd)).files;
  assert.deepEqual(got, []);
});

test('빈 파일은 올리지 않는다', async () => {
  const got = (await collectImages('empty.png 확인', cwd)).files;
  assert.deepEqual(got, []);
});

test('그림이 아닌 것은 건드리지 않는다', async () => {
  const got = (await collectImages('src/index.js 를 고쳤다', cwd)).files;
  assert.deepEqual(got, []);
});

test('여러 개면 중복 없이 모은다', async () => {
  const got = (await collectImages('shots/preview.png 와 diagram.jpg 와 shots/preview.png', cwd)).files;
  assert.equal(got.length, 2);
});

test('답변이 비면 빈 배열', async () => {
  assert.deepEqual((await collectImages('', cwd)).files, []);
  assert.deepEqual((await collectImages(null, cwd)).files, []);
});

test('보내겠다고 한 경로를 작업 폴더 기준으로 푼다', async () => {
  const got = (await resolveSentFiles(['shots/preview.png', 'diagram.jpg'], cwd)).files;
  assert.deepEqual(got, [path.join(cwd, 'shots', 'preview.png'), path.join(cwd, 'diagram.jpg')]);
});

test('보내겠다고 해도 없는 파일은 뺀다', async () => {
  assert.deepEqual((await resolveSentFiles(['nope.png'], cwd)).files, []);
});

test('그림이 아니어도 보내겠다고 하면 보낸다', async () => {
  await fsp.writeFile(path.join(cwd, 'report.pdf'), 'x');
  assert.deepEqual((await resolveSentFiles(['report.pdf'], cwd)).files, [path.join(cwd, 'report.pdf')]);
});

test('마크다운 링크로 적어 둔 영상 경로도 잡는다', async () => {
  await fsp.writeFile(path.join(cwd, 'clip.mp4'), 'v');
  const got = (await collectImages('[영상 확인하기](clip.mp4) 보세요', cwd)).files;
  assert.deepEqual(got, [path.join(cwd, 'clip.mp4')]);
});

test('mov · webm 도 받는다', async () => {
  await fsp.writeFile(path.join(cwd, 'a.mov'), 'v');
  await fsp.writeFile(path.join(cwd, 'b.webm'), 'v');
  const got = (await collectImages('a.mov 와 b.webm', cwd)).files;
  assert.equal(got.length, 2);
});

test('한도를 넘으면 올리지 않고 따로 알린다', async () => {
  const big = path.join(cwd, 'huge.mp4');
  await fsp.writeFile(big, Buffer.alloc(25 * 1024 * 1024));
  const got = await collectImages('huge.mp4 만들었다', cwd);
  assert.deepEqual(got.files, []);
  assert.equal(got.tooBig.length, 1);
  assert.match(describeTooBig(got.tooBig), /못 올렸다/);
});

test('올릴 게 없으면 알릴 것도 없다', () => {
  assert.equal(describeTooBig([]), '');
});

test('/tmp 에 떨군 그림도 올린다', async () => {
  const shot = path.join('/tmp', `imgtest-${Date.now()}.png`);
  await fsp.writeFile(shot, png);
  const got = (await collectImages(`![작성 화면](${shot})`, cwd)).files;
  assert.deepEqual(got, [shot]);
  await fsp.rm(shot, { force: true });
});

test('/tmp 도 작업 폴더도 아니면 여전히 안 올린다', async () => {
  const got = (await collectImages(`저장했다: ${path.join(root, 'outside.png')}`, cwd, noTmp)).files;
  assert.deepEqual(got, []);
});

test('에이전트가 알려 준 자리의 그림도 올린다', async () => {
  const den = path.join(root, 'agent-media');
  const shot = path.join(den, 'made.png');
  await fsp.mkdir(den, { recursive: true });
  await fsp.writeFile(shot, png);
  assert.deepEqual((await collectImages(`![만든 것](${shot})`, cwd, noTmp)).files, []);
  assert.deepEqual((await collectImages(`![만든 것](${shot})`, cwd, { ...noTmp, extraRoots: [den] })).files, [shot]);
});

test('소리 파일도 올린다', async () => {
  const song = path.join(cwd, 'demo.mp3');
  await fsp.writeFile(song, Buffer.from('ID3'));
  assert.deepEqual((await collectImages(`[데모 듣기](${song})`, cwd)).files, [song]);
});

test('폴더 이름에 띄어쓰기가 있어도 마크다운 링크면 통째로 잡는다', async () => {
  const den = path.join(cwd, 'Tentative Images');
  await fsp.mkdir(den, { recursive: true });
  const shot = path.join(den, 'EV-001_2.png');
  await fsp.writeFile(shot, png);
  for (const text of [`![시안](${shot})`, `![시안](<${shot}>)`, `![시안](${shot.replace(/ /g, '%20')})`]) {
    assert.deepEqual((await collectImages(text, cwd)).files, [shot], text);
  }
});

test('보내겠다고 해도 작업 폴더 밖은 안 보낸다', async () => {
  await fsp.writeFile(path.join(root, 'secret.txt'), 'x');
  assert.deepEqual((await resolveSentFiles([path.join(root, 'secret.txt')], cwd, noTmp)).files, []);
  assert.deepEqual((await resolveSentFiles(['../secret.txt'], cwd, noTmp)).files, []);
});

test('점으로 시작하는 파일과 키가 사는 폴더는 안 보낸다', async () => {
  await fsp.writeFile(path.join(cwd, '.env'), 'TOKEN=x');
  await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.git', 'config'), 'x');
  assert.deepEqual((await resolveSentFiles(['.env', '.git/config'], cwd)).files, []);
});

test('점 폴더라도 키가 사는 곳이 아니면 올린다', async () => {
  const den = path.join(cwd, '.worktrees', 'try');
  await fsp.mkdir(den, { recursive: true });
  await fsp.writeFile(path.join(den, 'take.mp3'), Buffer.from('ID3'));
  assert.deepEqual((await collectImages('.worktrees/try/take.mp3', cwd)).files, [path.join(den, 'take.mp3')]);
});

test('작업 폴더 안의 링크가 밖을 가리키면 안 올린다', async () => {
  await fsp.writeFile(path.join(root, 'key.png'), png);
  await fsp.symlink(path.join(root, 'key.png'), path.join(cwd, 'shot.png'));
  assert.deepEqual((await collectImages('shot.png', cwd, noTmp)).files, []);
  assert.deepEqual((await resolveSentFiles(['shot.png'], cwd, noTmp)).files, []);
});
