import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, availableCommands, filterCommands, fuzzyFilter, fuzzyScore } from '../src/ui/palette.js';

test('the palette lists the commands of doc/ui.md', () => {
  const titles = COMMANDS.map((c) => c.title);
  for (const t of ['Run', 'Stop', 'Panic', 'New Project', 'Open Project', 'Toggle Console', 'Toggle Problems', 'Toggle IR', 'Toggle Trace',
    'Replay', 'Go Live', 'Download Trace', 'Open Settings', 'Open Guide', 'Run Fullscreen']) {
    assert.ok(titles.includes(t), t);
  }
});

test('fuzzy score requires characters in order', () => {
  assert.equal(fuzzyScore('Toggle console', 'tgc'), fuzzyScore('Toggle console', 'tgc'));
  assert.notEqual(fuzzyScore('Toggle console', 'tgc'), null);
  assert.equal(fuzzyScore('Toggle console', 'xyz'), null);
  assert.equal(fuzzyScore('Run', ''), 0);
});

test('prefix and word-start matches rank first', () => {
  const r = filterCommands(COMMANDS, 'run');
  assert.equal(r[0].title, 'Run');
  assert.ok(r.some((c) => c.title === 'Run Fullscreen'));
  assert.equal(filterCommands(COMMANDS, 'tir')[0].title, 'Toggle IR');
  assert.equal(filterCommands(COMMANDS, 'guide')[0].title, 'Open Guide');
});

test('an empty query keeps every command in order', () => {
  assert.deepEqual(filterCommands(COMMANDS, '').map((c) => c.id), COMMANDS.map((c) => c.id));
});

test('availableCommands hides commands that need a piece, a project or an account', () => {
  const none = availableCommands(COMMANDS, {}).map((c) => c.id);
  assert.deepEqual(none, ['download-trace', 'open-guide']);
  const editor = availableCommands(COMMANDS, { piece: true, project: true, signedIn: true });
  assert.equal(editor.length, COMMANDS.length);
  assert.ok(!availableCommands(COMMANDS, { piece: true }).some((c) => c.id === 'run-fullscreen'));
});

test('fuzzyFilter works on project names', () => {
  const projects = [{ name: 'Example: Station chord' }, { name: 'Solar wind sketch' }, { name: 'Bells' }];
  assert.deepEqual(fuzzyFilter(projects, 'sw', (p) => p.name).map((p) => p.name), ['Solar wind sketch']);
  assert.deepEqual(fuzzyFilter(projects, 'stch', (p) => p.name).map((p) => p.name), ['Example: Station chord', 'Solar wind sketch']);
});
