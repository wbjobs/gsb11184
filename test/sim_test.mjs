/* 多标签页模拟验收测试：在 vm 中真实运行 app.js（不修改源码），
 * Mock BroadcastChannel / IndexedDB / sessionStorage / DOM / Canvas。 */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (cond, name) => { console.log((cond ? '  PASS ' : '  FAIL ') + name); if (!cond) failures++; };

/* ---------- BroadcastChannel 总线（带随机小延迟，模拟乱序投递） ---------- */
const channels = new Set();
class MockBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; channels.add(this); }
  postMessage(msg) {
    for (const ch of [...channels]) {
      if (ch !== this && ch.name === this.name && ch.onmessage) {
        const data = structuredClone(msg);
        setTimeout(() => ch.onmessage && ch.onmessage({ data }), Math.floor(Math.random() * 8));
      }
    }
  }
  close() { channels.delete(this); }
}

/* ---------- IndexedDB 内存实现（同一标签页刷新后数据保留） ---------- */
function makeIDB() {
  const data = new Map();
  const db = {
    transaction() {
      const tx = { oncomplete: null, onerror: null };
      tx.objectStore = () => ({
        put(v, k) { data.set(k, v); setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); return {}; },
        get(k) {
          const r = { onsuccess: null, onerror: null };
          setTimeout(() => { r.result = data.get(k); r.onsuccess && r.onsuccess(); }, 0);
          return r;
        },
      });
      return tx;
    },
    close() {},
    createObjectStore() {},
  };
  return {
    open() {
      const req = {};
      setTimeout(() => { req.result = db; req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); }, 0);
      return req;
    },
  };
}

/* ---------- DOM / Canvas 桩 ---------- */
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', checked: false, style: {},
    width: 820, height: 120, scrollTop: 0, scrollHeight: 0,
    _h: {},
    addEventListener(ev, fn) { (this._h[ev] ??= []).push(fn); },
    click() { (this._h.click || []).forEach((f) => f()); },
    getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); },
  };
}
const EL_IDS = ['myId','onlineCount','roster','msgInput','sendBtn','staleBtn','senderArea',
  'cAck','cPending','cTimeout','retryInfo','cv','loseAck','recvBox','log'];

/* ---------- 标签页 ---------- */
let tabSeq = 0;
function createTab(persist) {
  const token = ++tabSeq;
  const els = Object.fromEntries(EL_IDS.map((id) => [id, makeEl(id)]));
  const timers = [];
  const tab = { els, token, timers, persist };
  const sandbox = {
    document: { getElementById: (id) => els[id] },
    BroadcastChannel: class extends MockBroadcastChannel {
      constructor(name) { super(name); this.__tab = token; }
    },
    indexedDB: persist.idb,
    sessionStorage: persist.ss,
    crypto, console, Date, JSON, Map, Set, Promise, Math, structuredClone,
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.push(h); return h; },
    setTimeout, clearInterval, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  tab.sandbox = sandbox;
  return tab;
}
function newTab() {
  const ssMap = new Map();
  const persist = {
    idb: makeIDB(),
    ss: { getItem: (k) => (ssMap.has(k) ? ssMap.get(k) : null), setItem: (k, v) => ssMap.set(k, String(v)) },
  };
  return createTab(persist);
}
function reloadTab(tab) {           // 刷新：清定时器、断频道，复用 sessionStorage + IndexedDB
  teardownRuntime(tab);
  return createTab(tab.persist);
}
function closeTab(tab) { teardownRuntime(tab); }
function teardownRuntime(tab) {
  tab.timers.forEach(clearInterval);
  for (const ch of [...channels]) if (ch.__tab === tab.token) channels.delete(ch);
}

/* ---------- 断言辅助 ---------- */
const counts = (t) => ({ ack: +t.els.cAck.textContent, pen: +t.els.cPending.textContent,
  to: +t.els.cTimeout.textContent, online: +t.els.onlineCount.textContent });
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeoutMs) { console.log('  TIMEOUT: ' + label); return false; }
    await sleep(120);
  }
}
const send = (t, text) => { t.els.msgInput.value = text; t.els.sendBtn.click(); };

/* ================= 验收场景 ================= */
console.log('== 1. 4 个标签页全部确认 ==');
const A = newTab(), B = newTab(), C = newTab(), D = newTab();
assert(await waitFor(() => counts(A).online === 4, 6000, 'discovery'), '4 个标签页互相发现');
send(A, '消息一');
assert(await waitFor(() => { const c = counts(A); return c.ack === 3 && c.pen === 0 && c.to === 0; }, 5000, '3 acks'),
  'A 显示 已确认=3 未确认=0 超时=0');
assert(B.els.recvBox.textContent.includes('消息一'), 'B 收到消息一');

console.log('== 2. 消息乱序不误判 ==');
A.els.staleBtn.click();
await sleep(400);
assert(B.els.log.textContent.includes('忽略乱序旧消息'), 'B 忽略过期序号消息');
assert(!B.els.recvBox.textContent.includes('乱序测试'), 'B 接收区不被旧消息覆盖');

console.log('== 3. 确认丢失 -> 超时 -> 重发 -> 补确认 ==');
D.els.loseAck.checked = true;
send(A, '消息二');
assert(await waitFor(() => { const c = counts(A); return c.ack === 2 && c.pen === 1; }, 5000, '2ack 1pen'),
  'D 丢确认后 A 显示 已确认=2 未确认=1');
assert(await waitFor(() => counts(A).to === 1, 8000, 'timeout=1'), '超时后 A 显示 超时=1');
assert(A.els.log.textContent.includes('重发'), 'A 超时后自动重发');
D.els.loseAck.checked = false;
assert(await waitFor(() => { const c = counts(A); return c.ack === 3 && c.to === 0; }, 12000, 'ack after retry'),
  '重发后 D 补确认，A 显示 已确认=3 超时=0');

console.log('== 4. 标签页中途关闭，未确认数更新 ==');
C.els.loseAck.checked = true;
send(A, '消息三');
assert(await waitFor(() => counts(A).pen === 1, 5000, 'C pending'), 'C 未确认=1');
closeTab(C);
assert(await waitFor(() => { const c = counts(A); return c.pen === 0 && c.to === 0 && c.ack === 2 && c.online === 3; }, 8000, 'close update'),
  'C 关闭后 未确认=0（期望集合收缩），在线=3');

console.log('== 5. 刷新接收方标签页，状态一致 ==');
const B2 = reloadTab(B);
assert(await waitFor(() => B2.els.recvBox.textContent.includes('消息三'), 5000, 'B restored'),
  'B 刷新后恢复显示最近广播');
await sleep(600);
assert(counts(A).ack === 2 && counts(A).pen === 0, 'A 计数不受 B 刷新影响');

console.log('== 6. 刷新发送方标签页，在途消息状态恢复 ==');
D.els.loseAck.checked = true;
send(A, '消息四');
await sleep(500);
const A2 = reloadTab(A);
assert(await waitFor(() => counts(A2).pen === 1, 6000, 'A restored in-flight'),
  'A 刷新后恢复在途消息（D 未确认=1）');
assert(A2.els.log.textContent.includes('恢复在途广播'), 'A 日志记录状态恢复');
D.els.loseAck.checked = false;
assert(await waitFor(() => { const c = counts(A2); return c.ack === 2 && c.pen === 0 && c.to === 0; }, 15000, 'final'),
  'D 恢复确认后 A 显示 已确认=2 未确认=0 超时=0');

console.log('== 7. 发送方关闭，其他标签页不崩 ==');
closeTab(A2);
assert(await waitFor(() => counts(B2).online === 2, 8000, 'roster shrinks'),
  'B 看到发送方离线（在线=2），页面正常运行');
assert(D.els.recvBox.textContent.includes('消息四'), 'D 保留最后收到的消息');

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
