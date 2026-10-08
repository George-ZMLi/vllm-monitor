import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadCore() {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('index.html 缺少内联 <script>');
  const module = { exports: {} };
  const ctx = vm.createContext({ module, console, setTimeout, clearTimeout, URL, AbortController });
  vm.runInContext(m[1], ctx, { filename: 'index.html#inline' });
  return module.exports;
}

export function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function')
    r.then(() => console.log('  ok -', name), (e) => { console.error('  FAIL -', name, e); process.exitCode = 1; });
  else console.log('  ok -', name);
}
export const flush = () => new Promise((r) => setTimeout(r, 20));
