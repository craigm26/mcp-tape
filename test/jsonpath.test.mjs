import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPath } from '../dist/jsonpath.js';

test('$ matches root', () => {
  assert.equal(matchPath('$', []), true);
  assert.equal(matchPath('$', ['a']), false);
});

test('$.field matches single field at root', () => {
  assert.equal(matchPath('$.foo', ['foo']), true);
  assert.equal(matchPath('$.foo', ['bar']), false);
  assert.equal(matchPath('$.foo', ['foo', 'x']), false);
});

test('$.a.b matches nested', () => {
  assert.equal(matchPath('$.a.b', ['a', 'b']), true);
  assert.equal(matchPath('$.a.b', ['a', 'c']), false);
});

test('$.a[*] matches any index', () => {
  assert.equal(matchPath('$.a[*]', ['a', '0']), true);
  assert.equal(matchPath('$.a[*]', ['a', '5']), true);
  assert.equal(matchPath('$.a[*]', ['a', 'x']), true);
  assert.equal(matchPath('$.a[*]', ['a']), false);
});

test('$.a[0] matches specific index', () => {
  assert.equal(matchPath('$.a[0]', ['a', '0']), true);
  assert.equal(matchPath('$.a[0]', ['a', '1']), false);
});

test('$..key recursive descent', () => {
  assert.equal(matchPath('$..secret', ['secret']), true);
  assert.equal(matchPath('$..secret', ['a', 'secret']), true);
  assert.equal(matchPath('$..secret', ['a', 'b', 'c', 'secret']), true);
  assert.equal(matchPath('$..secret', ['a', 'b', 'public']), false);
});
