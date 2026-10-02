// Tests for the detection toggles of the options page, run under Node against a stand-in
// for the page and for `chrome`.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// Loads options.js into a fresh context. `granted` says whether access to all sites is
// held, `agree` what the reader answers when asked for it.
async function open({ settings = {}, granted = false, agree = true } = {}) {
  const elements = {};
  const element = () => ({
    on: {}, value: 'all', checked: false, textContent: '', hidden: false,
    classList: { toggle() {} },
    tBodies: [{ replaceChildren() {} }],
    append() {},
    addEventListener(type, fn) { this.on[type] = fn; },
  });
  const sent = [];
  const access = { granted, asked: 0 };
  const listeners = {};
  const event = (name) => ({ addListener: (fn) => void (listeners[name] = fn) });
  const ctx = vm.createContext({
    Intl, URL, console,
    document: {
      getElementById: (id) => (elements[id] ??= element()),
      getElementsByName: () => [],
      createElement: element,
    },
    chrome: {
      storage: { local: { get: async () => ({ settings }) }, onChanged: event('changed') },
      permissions: {
        contains: async () => access.granted,
        request: async () => {
          access.asked++;
          if (agree && !access.granted) {
            access.granted = true;
            // The page hears of the grant, and draws itself again, before the answer is in.
            await listeners.added();
          }
          return agree;
        },
        onAdded: event('added'),
        onRemoved: event('removed'),
      },
      runtime: { sendMessage: async (message) => (sent.push(structuredClone(message)), { ok: true }) },
    },
  });
  for (const f of ['seed.js', 'psl.js', 'shared.js', 'options.js']) vm.runInContext(src(f), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 5));
  const toggle = async (name, checked) => {
    elements[name].checked = checked;
    await elements[name].on.change({ target: elements[name] });
  };
  return { elements, sent, access, toggle };
}

test('options: a detector left on in storage shows as off without the access, and does not come back with the other', async () => {
  const o = await open({ settings: { visitDetect: true, bgCheck: true } });
  assert.deepEqual([o.elements.visitDetect.checked, o.elements.bgCheck.checked], [false, false]);
  await o.toggle('bgCheck', true);
  assert.deepEqual(o.sent, [{ type: 'setSettings', patch: { visitDetect: false, bgCheck: true } }]);
});

test('options: with the access held, a toggle changes its own setting only', async () => {
  const o = await open({ settings: { visitDetect: true }, granted: true });
  assert.deepEqual([o.elements.visitDetect.checked, o.elements.bgCheck.checked], [true, false]);
  await o.toggle('bgCheck', true);
  await o.toggle('visitDetect', false);
  assert.deepEqual(o.sent.map((m) => m.patch), [{ bgCheck: true }, { visitDetect: false }]);
  // Switching off asks for nothing.
  assert.equal(o.access.asked, 1);
});

test('options: a detector stays off when the access is refused', async () => {
  const o = await open({ agree: false });
  await o.toggle('visitDetect', true);
  assert.deepEqual([o.sent, o.elements.visitDetect.checked], [[], false]);
});

test('options: turning a detector on for the first time turns that one on', async () => {
  const o = await open();
  await o.toggle('visitDetect', true);
  assert.deepEqual(o.sent, [{ type: 'setSettings', patch: { visitDetect: true, bgCheck: false } }]);
});
