// Tests for the detection toggles of the options page, run under Node against a stand-in
// for the page and for `chrome`.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

// Loads options.js into a fresh context. `granted` says whether access to all sites is
// held, `agree` what the reader answers when asked for it, `answer` what the service worker
// says to a request (null: the request fails; 'nothing': it is answered with nothing).
async function open({ settings = {}, granted = false, agree = true, answer = { ok: true } } = {}) {
  const elements = {};
  const drawn = { count: 0, rows: [] };
  const element = () => ({
    on: {}, value: 'all', checked: false, textContent: '', hidden: false,
    kids: [],
    classList: { toggle(name, on) { this[name] = on; } },
    tBodies: [{ replaceChildren(...rows) { drawn.count++; drawn.rows = rows; } }],
    append(...kids) { this.kids.push(...kids); },
    setAttribute() {},
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
        remove: async () => void (access.granted = false),
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
      runtime: {
        id: 'hnpfextensionid',
        sendMessage: async (message) => {
          sent.push(structuredClone(message));
          if (!answer) throw new Error('Could not establish connection.');
          return answer === 'nothing' ? undefined : answer;
        },
      },
    },
  });
  for (const f of ['seed.js', 'psl.js', 'shared.js', 'options.js']) vm.runInContext(src(f), ctx, { filename: f });
  await new Promise((r) => setTimeout(r, 5));
  const toggle = async (name, checked) => {
    elements[name].checked = checked;
    await elements[name].on.change({ target: elements[name] });
  };
  const changed = async (changes, area = 'local') => {
    listeners.changed(changes, area);
    await new Promise((r) => setTimeout(r, 5));
  };
  // Elements come into being when first asked for, by the page or by a test.
  const el = (id) => (elements[id] ??= element());
  return { elements, el, sent, access, toggle, drawn, changed };
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

test('options: the table is not drawn again for what the background check caches', async () => {
  const o = await open();
  const before = o.drawn.count;
  await o.changed({ checks: {} });
  await o.changed({ sites: {} }, 'session');
  assert.equal(o.drawn.count, before);
  for (const key of ['sites', 'pages', 'settings']) await o.changed({ [key]: {}, checks: {} });
  assert.equal(o.drawn.count, before + 3);
});

test('options: a setting the service worker refuses, or that never reaches it, is reported and shown as stored', async () => {
  const unreachable = 'Not changed: the extension could not be reached.';
  for (const [answer, said] of [[{ ok: false, error: 'not a setting' }, 'Not changed: not a setting.'], [null, unreachable], ['nothing', unreachable]]) {
    const o = await open({ settings: { visitDetect: false, bgCheck: true }, granted: true, answer });
    await o.toggle('visitDetect', true);
    assert.equal(o.el('settingsStatus').textContent, said);
    assert.equal(o.el('settingsStatus').classList.error, true);
    assert.equal(o.elements.visitDetect.checked, false, 'the box goes back to what is stored');
    // With the other detector on, the access stays.
    assert.equal(o.access.granted, true);
  }
  // The access granted for a detector that then did not come on is given back.
  const first = await open({ answer: null });
  await first.toggle('bgCheck', true);
  assert.deepEqual([first.access.asked, first.access.granted, first.el('bgCheck').checked], [1, false, false]);
  // Said once: the next change that goes through takes it away.
  const o = await open({ granted: true });
  o.el('settingsStatus').textContent = 'Not changed: before.';
  await o.toggle('visitDetect', true);
  assert.equal(o.el('settingsStatus').textContent, '');
});

test('options: a request that never reaches the service worker is reported under the form', async () => {
  const o = await open({ answer: null });
  o.el('addInput').value = 'example.com';
  await o.el('addForm').on.submit({ preventDefault() {} });
  assert.equal(o.el('addStatus').textContent, 'Not changed: the extension could not be reached.');
  assert.equal(o.el('addInput').value, 'example.com');
});

test('options: a change to an entry that fails is reported in its own row', async () => {
  const o = await open({ answer: null });
  // A row is its cells: name, state, why, and the buttons with a note after them.
  const [name, , , actions] = o.drawn.rows[0].kids;
  const note = actions.kids.at(-1);
  await actions.kids.find((k) => k.textContent === 'Always show').on.click();
  assert.equal(o.sent.at(-1).domains[0], name.kids[0]);
  assert.equal(note.textContent, 'Not changed: the extension could not be reached.');
  assert.equal(note.classList.error, true);
});

test('options: access granted for a detector that did not come on is given back, though one was left on in storage', async () => {
  const o = await open({ settings: { visitDetect: true, bgCheck: true }, answer: null });
  await o.toggle('bgCheck', true);
  assert.equal(o.access.granted, false);
  assert.deepEqual([o.el('visitDetect').checked, o.el('bgCheck').checked], [false, false]);
});

test('options: a declined prompt takes away what was said about the last change', async () => {
  const o = await open({ agree: false });
  o.el('settingsStatus').textContent = 'Not changed: before.';
  await o.toggle('visitDetect', true);
  assert.equal(o.el('settingsStatus').textContent, '');
});
