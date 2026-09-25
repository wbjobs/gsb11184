'use strict';

/* ================= 常量 ================= */
const CHANNEL_NAME = 'tab-broadcast-ack-v1';
const HEARTBEAT_MS = 1000;   // 心跳间隔
const EXPIRE_MS = 3500;      // 超过该时间无心跳视为标签页已关闭
const TIMEOUT_MS = 4000;     // 单次确认超时
const MAX_RETRY = 3;         // 超时后最大重发次数
const TICK_MS = 250;         // 状态巡检间隔

/* ================= 标签页身份 =================
 * tabId 存 sessionStorage：同一标签页刷新后身份不变（状态可恢复），
 * 新标签页获得新身份。 */
const tabId = (() => {
  let id = sessionStorage.getItem('tabId');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    sessionStorage.setItem('tabId', id);
  }
  return id;
})();
const short = (id) => id.slice(0, 4);

/* ================= 运行时状态 ================= */
const bc = new BroadcastChannel(CHANNEL_NAME);
const roster = new Map();        // tabId -> lastSeen（不含自己）
let mySeq = 0;                   // 本标签页作为发送方的消息序号
let currentMsg = null;           // 发送方当前在途消息
/* currentMsg = { msgId, seq, text, expected:Set, acks:Set, timedOut:Set, retries, deadline, done } */
const lastSeqBySender = new Map(); // senderId -> 已接受的最大 seq（乱序防护）
let lastRecv = null;             // 接收方最近一条消息 { senderId, msgId, seq, text }

/* ================= IndexedDB（刷新后恢复状态） ================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('broadcast-ack-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
function persistSender() {
  if (!currentMsg) return idbSet('senderState', null);
  return idbSet('senderState', {
    ...currentMsg,
    expected: [...currentMsg.expected],
    acks: [...currentMsg.acks],
    timedOut: [...currentMsg.timedOut],
  });
}
const persistRecv = () => idbSet('lastReceived', lastRecv);

/* ================= 日志与 DOM ================= */
const $ = (id) => document.getElementById(id);
function log(text) {
  const el = $('log');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.textContent += `[${time}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

/* ================= 消息收发 ================= */
function post(obj) {
  bc.postMessage({ ...obj, tabId });
}

function sendBroadcast() {
  const text = $('msgInput').value.trim() || '(空消息)';
  mySeq += 1;
  const expected = new Set(roster.keys()); // 发送瞬间的在线其他标签页
  currentMsg = {
    msgId: tabId + ':' + mySeq,
    seq: mySeq,
    text,
    expected,
    acks: new Set(),
    timedOut: new Set(),
    retries: 0,
    deadline: Date.now() + TIMEOUT_MS,
    done: false,
  };
  persistSender();
  post({ type: 'msg', msgId: currentMsg.msgId, seq: mySeq, text });
  log(`发送广播 #${mySeq}，期望 ${expected.size} 个标签页确认`);
  if (expected.size === 0) log('当前没有其他在线标签页');
  render();
}

function sendAck(senderId, msgId) {
  post({ type: 'ack', msgId, to: senderId });
}

function handleMsg(m) {
  if (m.tabId === tabId) return; // 自己发的忽略
  const lastSeq = lastSeqBySender.get(m.tabId) ?? -1;

  if (m.seq < lastSeq) {
    log(`忽略乱序旧消息 seq=${m.seq}（已处理到 seq=${lastSeq}）`);
    return; // 乱序旧消息，不误判
  }
  const isDup = lastRecv && lastRecv.msgId === m.msgId;
  if (!isDup) {
    lastSeqBySender.set(m.tabId, m.seq);
    lastRecv = { senderId: m.tabId, msgId: m.msgId, seq: m.seq, text: m.text };
    persistRecv();
    log(`收到来自 ${short(m.tabId)} 的广播 #${m.seq}：${m.text}`);
    renderRecv();
  }
  if ($('loseAck').checked) {
    if (!isDup) log('已开启“模拟确认丢失”，不回复 ACK');
    return;
  }
  sendAck(m.tabId, m.msgId); // 重复消息也幂等重确认
}

function handleAck(m) {
  if (m.to !== tabId || !currentMsg || currentMsg.done) return;
  if (m.msgId !== currentMsg.msgId) return; // 旧消息的迟到 ACK，忽略
  if (!currentMsg.expected.has(m.tabId)) return; // 不在期望集合内（如中途新加入的），不计数
  if (!currentMsg.acks.has(m.tabId)) {
    currentMsg.acks.add(m.tabId);
    currentMsg.timedOut.delete(m.tabId);
    persistSender();
    log(`收到 ${short(m.tabId)} 的确认（${currentMsg.acks.size}/${activeExpected().length}）`);
    maybeFinish();
    render();
  }
}

function handleSyncRequest(m) {
  // 发送方刷新后重新收集确认状态
  if (m.tabId === tabId) return;
  if (lastRecv && lastRecv.msgId === m.msgId && !$('loseAck').checked) {
    sendAck(m.tabId, m.msgId);
  }
}

bc.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'heartbeat':
    case 'hello':
      if (m.tabId !== tabId) {
        const isNew = !roster.has(m.tabId);
        roster.set(m.tabId, Date.now());
        if (isNew) { log(`标签页 ${short(m.tabId)} 上线`); render(); }
        if (m.type === 'hello') post({ type: 'heartbeat' }); // 回应新上线者
      }
      break;
    case 'msg': handleMsg(m); break;
    case 'ack': handleAck(m); break;
    case 'sync-request': handleSyncRequest(m); break;
  }
};

/* ================= 超时与重发 ================= */
function activeExpected() {
  if (!currentMsg) return [];
  return [...currentMsg.expected].filter((id) => roster.has(id));
}

function maybeFinish() {
  const active = activeExpected();
  if (currentMsg && !currentMsg.done && active.every((id) => currentMsg.acks.has(id))) {
    currentMsg.done = true;
    persistSender();
    log(`全部 ${active.length} 个在线标签页已确认 ✔`);
  }
}

function tick() {
  // 清理下线标签页
  const now = Date.now();
  let changed = false;
  for (const [id, seen] of roster) {
    if (now - seen > EXPIRE_MS) {
      roster.delete(id);
      lastSeqBySender.delete(id);
      changed = true;
      log(`标签页 ${short(id)} 已离线`);
    }
  }

  if (currentMsg && !currentMsg.done) {
    maybeFinish();
    if (!currentMsg.done && now > currentMsg.deadline) {
      const missing = activeExpected().filter((id) => !currentMsg.acks.has(id));
      missing.forEach((id) => currentMsg.timedOut.add(id)); // 错过截止时间即记为超时，补确认后消除
      if (currentMsg.retries < MAX_RETRY && missing.length > 0) {
        currentMsg.retries += 1;
        currentMsg.deadline = now + TIMEOUT_MS;
        persistSender();
        post({ type: 'msg', msgId: currentMsg.msgId, seq: currentMsg.seq, text: currentMsg.text });
        log(`超时未确认 ${missing.length} 个，第 ${currentMsg.retries} 次重发`);
      } else if (currentMsg.retries >= MAX_RETRY) {
        currentMsg.done = true;
        persistSender();
        log(`已达最大重发次数，${missing.length} 个标签页最终超时`);
      }
    }
  }
  if (changed || currentMsg) render();
}

/* ================= 渲染 ================= */
function renderRoster() {
  $('onlineCount').textContent = roster.size + 1;
  const parts = [`<span class="badge me">${short(tabId)}（我）</span>`];
  for (const id of roster.keys()) parts.push(`<span class="badge">${short(id)}</span>`);
  $('roster').innerHTML = parts.join(' ');
}

function renderRecv() {
  $('recvBox').textContent = lastRecv
    ? `来自 ${short(lastRecv.senderId)} 的广播 #${lastRecv.seq}：\n${lastRecv.text}`
    : '暂无收到的广播';
}

function statusOf(id) {
  if (currentMsg.acks.has(id)) return 'acked';
  if (currentMsg.timedOut.has(id)) return 'timeout';
  return 'pending';
}

function render() {
  renderRoster();
  if (!currentMsg) { $('senderArea').style.display = 'none'; return; }
  $('senderArea').style.display = 'block';

  const active = activeExpected();
  let ack = 0, pending = 0, timeout = 0;
  for (const id of active) {
    const s = statusOf(id);
    if (s === 'acked') ack++;
    else if (s === 'timeout') timeout++;
    else pending++;
  }
  $('cAck').textContent = ack;
  $('cPending').textContent = pending;
  $('cTimeout').textContent = timeout;
  $('retryInfo').textContent = currentMsg.done
    ? '已结束'
    : `已重发 ${currentMsg.retries}/${MAX_RETRY} 次`;
  drawCanvas(active);
}

/* Canvas 实时可视化：每个期望确认的标签页一个圆点 */
function drawCanvas(active) {
  const cv = $('cv');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.font = '12px sans-serif';

  const colors = { acked: '#16a34a', pending: '#d97706', timeout: '#dc2626' };
  const labels = { acked: '已确认', pending: '等待中', timeout: '已超时' };

  if (active.length === 0) {
    ctx.fillStyle = '#888';
    ctx.fillText('当前没有需要确认的在线标签页', 16, 40);
    return;
  }
  const perRow = Math.max(1, Math.floor((cv.width - 32) / 110));
  active.forEach((id, i) => {
    const x = 40 + (i % perRow) * 110;
    const y = 40 + Math.floor(i / perRow) * 56;
    const s = statusOf(id);
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fillStyle = colors[s];
    ctx.fill();
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.fillText(short(id), x, y + 32);
    ctx.fillStyle = colors[s];
    ctx.fillText(labels[s], x, y + 46);
  });
  ctx.textAlign = 'left';
}

/* ================= 启动 ================= */
async function init() {
  $('myId').textContent = short(tabId) + '（刷新后身份不变）';
  $('sendBtn').addEventListener('click', sendBroadcast);
  $('staleBtn').addEventListener('click', () => {
    if (!currentMsg) { log('请先发送一条广播'); return; }
    post({ type: 'msg', msgId: tabId + ':stale', seq: currentMsg.seq - 1, text: '[乱序测试] 这是一条过期消息' });
    log('已注入一条过期序号消息，其他标签页应忽略它');
  });

  // 从 IndexedDB 恢复状态，保证刷新后一致
  const savedSender = await idbGet('senderState');
  if (savedSender && !savedSender.done) {
    currentMsg = {
      ...savedSender,
      expected: new Set(savedSender.expected),
      acks: new Set(savedSender.acks),
      timedOut: new Set(savedSender.timedOut || []),
      deadline: Date.now() + TIMEOUT_MS, // 刷新后给一个完整的确认窗口
    };
    mySeq = currentMsg.seq;
    log(`恢复在途广播 #${mySeq}，重新收集确认`);
    post({ type: 'sync-request', msgId: currentMsg.msgId });
  }
  const savedRecv = await idbGet('lastReceived');
  if (savedRecv) {
    lastRecv = savedRecv;
    lastSeqBySender.set(savedRecv.senderId, savedRecv.seq);
    renderRecv();
    // 主动补发确认，让（可能也刷新过的）发送方状态一致
    if (!$('loseAck').checked) sendAck(savedRecv.senderId, savedRecv.msgId);
  }

  post({ type: 'hello' });
  setInterval(() => post({ type: 'heartbeat' }), HEARTBEAT_MS);
  setInterval(tick, TICK_MS);
  render();
  log(`标签页 ${short(tabId)} 已启动`);
}

init();
