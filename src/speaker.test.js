import assert from 'node:assert/strict';
import test from 'node:test';

import { withSpeaker } from './speaker.js';

test('말한 사람 이름을 앞에 붙인다', () => {
  assert.equal(withSpeaker('결론: 이거 바꿔', '앨리스'), '[앨리스] 결론: 이거 바꿔');
});

test('에이전트 명령은 그대로 둔다', () => {
  // 앞에 뭐가 붙으면 /compact 가 명령으로 안 먹는다.
  assert.equal(withSpeaker('/compact', '앨리스'), '/compact');
});

test('이름을 모르면 그대로 둔다', () => {
  assert.equal(withSpeaker('안녕', ''), '안녕');
  assert.equal(withSpeaker('안녕', undefined), '안녕');
});
