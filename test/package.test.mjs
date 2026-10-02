// Checks on the extension as it is loaded: that every file it names is there, and that
// no script has a syntax error. That is all of a linter's work they do, with nothing to
// install.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const at = (file) => new URL(`../${file}`, import.meta.url);
const read = (file) => readFileSync(at(file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const scripts = readdirSync(at('src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`);

test('every script parses', () => {
  assert.ok(scripts.length > 0);
  // Compiled, not run. None of them is a module, which is how the browser loads them too.
  for (const file of scripts) assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), file);
});

test('every file the manifest names is there', () => {
  const named = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])]),
  ];
  for (const file of named) assert.ok(existsSync(at(file)), file);
});

test('every file a page or the service worker loads is there', () => {
  const quoted = (text) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const worker = read(manifest.background.service_worker);
  // importScripts names files next to the worker, executeScript from the extension's root.
  const imported = [...worker.matchAll(/importScripts\((.*)\)/g)].flatMap((m) => quoted(m[1])).map((f) => `src/${f}`);
  const injected = [...worker.matchAll(/files: \[(.*?)\]/g)].flatMap((m) => quoted(m[1]));
  assert.ok(imported.length > 0 && injected.length > 0);
  for (const file of [...imported, ...injected]) assert.ok(existsSync(at(file)), file);

  for (const page of [manifest.action.default_popup, manifest.options_ui.page]) {
    const linked = [...read(page).matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(linked.length > 0, page);
    for (const file of linked) assert.ok(existsSync(new URL(file, at(page))), `${page}: ${file}`);
  }
});

test('package.json says which Node runs the tests, and how', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.test, 'node --test');
  const [, oldest] = pkg.engines.node.match(/^>=(\d+)$/) || [];
  assert.ok(oldest, 'engines.node is ">=" and a major version');
  // The workflow tests on the oldest version that is promised to work.
  const [, tested] = read('.github/workflows/ci.yml').match(/node: \[\s*(\d+)\s*,/) || [];
  assert.equal(tested, oldest, 'the first Node version in the workflow is the oldest one package.json allows');
});
