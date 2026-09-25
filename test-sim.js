'use strict';
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const code = html.split('<script>')[1].split('</script>')[0];

// ---- 共享内存版 IndexedDB（同源共享） ----
const stores = { kv: new Map(), msgs: new Map() };
const req = (fn) => { const r = {}; setTimeout(() => { r.result = fn(); r.onsuccess && r.onsuccess(); }, 0); return r; };
const db = {
  transaction(store) {
    return { objectStore() { return {
      get: k => req(() => stores[store].get(k)),
      put: (v, k) => req(() => { stores[store].set(k !== undefined ? k : v.msgId, v); }),
    }; } };
  }
};
const indexedDB = { open() { return req(() => db); } };

// ---- 共享广播总线（随机 0-8ms 延迟，制造乱序） ----
const peers = new Set();
let currentChannel = null;
class BroadcastChannel {
  constructor() { peers.add(this); currentChannel = this; }
  set onmessage(f) { this._h = f; }
  postMessage(m) {
    for (const p of peers) if (p !== this && p._h) {
      const msg = JSON.parse(JSON.stringify(m));
      setTimeout(() => p._h && p._h({ data: msg }), Math.random() * 8);
    }
  }
}

function makeTab(name, session) {
  const els = {};
  const mkEl = () => ({
    textContent: '', innerHTML: '', value: '', checked: false, className: '',
    children: [], lastChild: null,
    _ev: {}, addEventListener(t, f) { this._ev[t] = f; },
    appendChild() {}, prepend() {}, remove() {},
    clientWidth: 800, clientHeight: 180,
    getContext: () => new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}), set: () => true }),
  });
  const tab = { name, session: session || {}, els, timers: new Set(),
    win: { _ev: {}, addEventListener(t, f) { this._ev[t] = f; }, devicePixelRatio: 1 } };
  const document = {
    getElementById: id => (els[id] = els[id] || mkEl()),
    createElement: () => mkEl(),
  };
  const sessionStorage = {
    getItem: k => (k in tab.session ? tab.session[k] : null),
    setItem: (k, v) => { tab.session[k] = String(v); },
  };
  const crypto = { randomUUID: () => name + '-' + Math.random().toString(36).slice(2, 10) };
  // 每标签页独立计时器，关闭/刷新时全部清除（模拟页面销毁）
  const tSetTimeout = (f, ms) => { const h = setTimeout(f, ms); tab.timers.add(h); return h; };
  const tSetInterval = (f, ms) => { const h = setInterval(f, ms); tab.timers.add(h); return h; };
  const tClear = h => { clearTimeout(h); clearInterval(h); tab.timers.delete(h); };
  new Function('BroadcastChannel', 'indexedDB', 'sessionStorage', 'document', 'window', 'crypto',
               'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', code)
    (BroadcastChannel, indexedDB, sessionStorage, document, tab.win, crypto,
     tSetTimeout, tSetInterval, tClear, tClear);
  tab.channel = currentChannel;
  tab.id = els.myId.textContent;
  tab.send = () => els.sendBtn._ev.click();
  tab.stats = () => ({ ack: +els.cAck.textContent, pend: +els.cPend.textContent, to: +els.cTo.textContent, state: els.roundState.textContent, online: +els.onlineCount.textContent });
  tab.close = () => { // 关闭或刷新：bye + 销毁页面（清计时器、断开频道）
    if (tab.win._ev.beforeunload) tab.win._ev.beforeunload();
    peers.delete(tab.channel); tab.channel._h = null;
    for (const h of tab.timers) { clearTimeout(h); clearInterval(h); }
    tab.timers.clear();
  };
  return tab;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  if (!cond) failures++;
}

(async () => {
  // 场景1：4 个标签页全部确认
  const A = makeTab('A'), B = makeTab('B'), C = makeTab('C');
  let D = makeTab('D');
  await sleep(300);
  check('4页互相发现 (online=4)', A.stats().online === 4, A.stats());
  A.send();
  await sleep(600);
  let s = A.stats();
  check('场景1: 全部确认 (ack=3,pend=0,to=0)', s.ack === 3 && s.pend === 0 && s.to === 0, s);

  // 场景2：标签页中途关闭，未确认数更新
  D.close();
  await sleep(200);
  check('D关闭后 online=3', A.stats().online === 3, A.stats());
  A.send();
  await sleep(600);
  s = A.stats();
  check('场景2: 关闭后新一轮 ack=2,pend=0', s.ack === 2 && s.pend === 0, s);

  // 场景3：确认丢失 -> 超时重发 -> 补确认
  B.els.dropAck.checked = true;
  A.send();
  await sleep(400);
  s = A.stats();
  check('场景3a: B丢确认 (ack=1,pend=1)', s.ack === 1 && s.pend === 1, s);
  B.els.dropAck.checked = false;
  await sleep(3500);
  s = A.stats();
  check('场景3b: 超时重发后B补确认 (ack=2,pend=0,to=0)', s.ack === 2 && s.pend === 0 && s.to === 0, s);

  // 场景4：持续丢确认 -> 记入超时数
  B.els.dropAck.checked = true;
  A.send();
  await sleep(10500);
  s = A.stats();
  check('场景4: B计入超时 (ack=1,to=1,pend=0)', s.ack === 1 && s.to === 1 && s.pend === 0, s);
  B.els.dropAck.checked = false;

  // 场景5：发送方关闭，其他标签页不崩，可继续广播
  let crashed = false;
  process.on('uncaughtException', e => { crashed = true; console.log('CRASH', e.message); });
  A.close();
  await sleep(200);
  C.send();
  await sleep(600);
  s = C.stats();
  check('场景5: A关闭后C正常广播 (ack=1,pend=0,无崩溃)', !crashed && s.ack === 1 && s.pend === 0, s);

  // 场景6：刷新接收方标签页（复用 session -> 同 tabId），状态一致
  const oldDId = D.id;
  D = makeTab('D', D.session); // 刷新 D（旧实例已在场景2关闭）
  await sleep(300);
  check('场景6a: 刷新后 tabId 不变', D.id === oldDId, { old: oldDId, now: D.id });
  C.send();
  await sleep(600);
  s = C.stats();
  check('场景6b: 刷新页重新上线并确认 (ack=2,pend=0)', s.ack === 2 && s.pend === 0, s);

  // 场景7：发送方刷新 -> 从 IndexedDB 恢复未完成轮次，继续重发统计
  D.els.dropAck.checked = true;
  B.send();
  await sleep(500);
  const bSession = B.session;
  B.close();                   // 刷新 = 销毁旧页
  const B2 = makeTab('B', bSession); // 同 session 重新加载
  await sleep(300);
  s = B2.stats();
  check('场景7a: 刷新后恢复未完成轮次', s.state.includes('进行中'), s);
  D.els.dropAck.checked = false;
  await sleep(7000);
  s = B2.stats();
  check('场景7b: 恢复后重发完成确认 (ack=2,pend=0,to=0)', s.ack === 2 && s.pend === 0 && s.to === 0, s);

  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
