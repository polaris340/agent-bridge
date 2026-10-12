import assert from 'node:assert/strict';
import test from 'node:test';

import { disambiguate } from './config.js';

test('겹치지 않으면 이름 그대로 쓴다', () => {
  const map = disambiguate([
    { name: 'my-app', dir: '/Users/me/workspace/my-app' },
    { name: 'my-game', dir: '/Users/me/Documents/workspace/game/my-game' },
  ]);
  assert.equal(map['my-app'], '/Users/me/workspace/my-app');
  assert.equal(map['my-game'], '/Users/me/Documents/workspace/game/my-game');
});

test('겹치면 부모를 붙여 둘 다 고를 수 있다', () => {
  const map = disambiguate([
    { name: 'demo', dir: '/Users/me/workspace/demo' },
    { name: 'demo', dir: '/Users/me/Documents/workspace/game/demo' },
  ]);
  assert.equal(map.demo, undefined, '맨 이름으로는 안 잡혀야 한다');
  assert.equal(map['workspace/demo'], '/Users/me/workspace/demo');
  assert.equal(map['game/demo'], '/Users/me/Documents/workspace/game/demo');
});

test('겹치는 것만 부모가 붙고 나머지는 그대로다', () => {
  const map = disambiguate([
    { name: 'demo', dir: '/a/workspace/demo' },
    { name: 'demo', dir: '/b/game/demo' },
    { name: 'my-app', dir: '/a/workspace/my-app' },
  ]);
  assert.equal(map['my-app'], '/a/workspace/my-app');
  assert.ok(map['workspace/demo'] && map['game/demo']);
});

test('부모 이름까지 같으면 한 단계 더 올라간다', () => {
  const map = disambiguate([
    { name: 'app', dir: '/one/src/app' },
    { name: 'app', dir: '/two/src/app' },
  ]);
  const keys = Object.keys(map);
  assert.equal(keys.length, 2, `둘 다 남아야 한다: ${keys.join(', ')}`);
  assert.deepEqual(new Set(Object.values(map)), new Set(['/one/src/app', '/two/src/app']));
});
