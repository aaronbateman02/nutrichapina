// Startup smoke test for the staff console (regression test for the TDZ crash:
// top-level `ui.*` assignments executed before `const ui` killed the whole page).
// Runs app.js top-to-bottom in Node with minimal DOM stubs and asserts the first
// paint renders. Usage: `node startup.smoke.cjs` (exit 0 = page boots).
const fs = require('fs');
const path = require('path');

const store = {};
global.window = { scrollY: 0, scrollTo() {} };
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
let rendered = '';
global.document = {
  documentElement: {},
  getElementById: (id) => (id === 'app' ? { set innerHTML(v) { rendered = String(v); } } : null),
  addEventListener() {},
  querySelectorAll: () => [],
};
global.fetch = async () => ({ ok: false, json: async () => null });

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
eval(src);

const assert = require('assert');
assert.ok(rendered.length > 1000, 'first paint rendered almost nothing');
assert.ok(rendered.includes('Nutri Chapina'), 'brand missing from first paint');
assert.ok(rendered.includes('Overview') || rendered.includes('Resumen'), 'nav missing from first paint');
console.log(`SMOKE OK: first paint rendered ${rendered.length} chars with zero startup errors`);
