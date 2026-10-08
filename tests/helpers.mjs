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

// 深度相等（跨 realm 安全：不比较原型链，vm 沙箱返回的对象也能通过）
export function deepEqual(a, b) {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null)
    return a === b || Object.is(a, b);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}
