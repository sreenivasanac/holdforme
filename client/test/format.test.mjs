// Transcript helpers of the recording player.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, day, lineAt, mergeLines } from '../src/format.ts';

const T0 = Date.parse('2026-11-11T10:00:00Z');
const l = (n, sec, who, text, at = null) => ({ n, t: new Date(T0 + sec * 1000).toISOString(), who, text, at });

test('merges close fragments of one speaker and keeps the first n and at', () => {
  const out = mergeLines([
    l(0, 0, 'event', 'Dialing'),
    l(1, 2, 'them', 'Your reference is N S', 2.1),
    l(2, 5, 'them', 'nine six six.', 5.3),
    l(3, 7, 'ai', 'Thanks.', 7),
    l(4, 9, 'them', 'Bye.', 9),
    l(5, 40, 'them', 'Hello?', 40), // same speaker, but long after
  ]);
  assert.deepEqual(out.map((x) => [x.n, x.text, x.at]), [
    [0, 'Dialing', null],
    [1, 'Your reference is N S nine six six.', 2.1],
    [3, 'Thanks.', 7],
    [4, 'Bye.', 9],
    [5, 'Hello?', 40],
  ]);
});

test('a merged bubble takes the first known at, when the first fragment has none', () => {
  const out = mergeLines([l(0, 0, 'them', 'a', null), l(1, 2, 'them', 'b', 2.4), l(2, 4, 'them', 'c', 4.1)]);
  assert.deepEqual(out.map((x) => [x.text, x.at]), [['a b c', 2.4]]);
});

test('an event between fragments stops the merge, and events never merge', () => {
  const out = mergeLines([l(0, 0, 'them', 'a'), l(1, 1, 'event', 'pressed 1'), l(2, 2, 'event', 'waiting'), l(3, 3, 'them', 'b')]);
  assert.equal(out.length, 4);
});

test('the gap is measured from the previous fragment, so a long run stays one bubble', () => {
  const out = mergeLines([l(0, 0, 'ai', 'a'), l(1, 8, 'ai', 'b'), l(2, 16, 'ai', 'c')]);
  assert.deepEqual(out.map((x) => x.text), ['a b c']);
});

test('lineAt finds the line that started last, skipping lines without at and events', () => {
  const lines = [l(0, 0, 'event', 'x', 0), l(1, 1, 'them', 'a', 1.5), l(2, 2, 'ai', 'b', null), l(3, 3, 'them', 'c', 10)];
  assert.equal(lineAt(lines, 0), -1);
  assert.equal(lineAt(lines, 1.5), 1);
  assert.equal(lineAt(lines, 9.9), 1);
  assert.equal(lineAt(lines, 10), 3);
  assert.equal(lineAt(lines, 999), 3);
});

test('ago', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(ago('2026-11-11T11:59:30Z', now), 'just now');
  assert.equal(ago('2026-11-11T11:55:00Z', now), '5 min ago');
  assert.equal(ago('2026-11-11T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-11-10T11:00:00Z', now), '1 day ago');
  assert.equal(ago('2026-11-01T12:00:00Z', now), '10 days ago');
});

test('day shows the year only for another year', () => {
  const now = new Date(2026, 10, 14);
  assert.doesNotMatch(day(new Date(2026, 1, 3).toISOString(), now), /2026/);
  assert.match(day(new Date(2025, 11, 30).toISOString(), now), /2025/);
});
