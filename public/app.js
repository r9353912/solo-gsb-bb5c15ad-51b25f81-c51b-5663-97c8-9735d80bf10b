/* Cookie Jar Lab —— 原生前端（无框架、无构建） */
'use strict';

const $ = (sel) => document.querySelector(sel);

const els = {
  storeUrl: $('#store-url'),
  storeTopUrl: $('#store-top-url'),
  storeCookie: $('#store-cookie'),
  storeBlock3p: $('#store-block-3p'),
  storeBtn: $('#store-btn'),
  fillDemo: $('#fill-demo'),
  storeResult: $('#store-result'),

  sendUrl: $('#send-url'),
  sendTopUrl: $('#send-top-url'),
  sendMethod: $('#send-method'),
  sendTopnav: $('#send-topnav'),
  sendBlock3p: $('#send-block-3p'),
  sendBtn: $('#send-btn'),
  sendResult: $('#send-result'),

  chainStartUrl: $('#chain-start-url'),
  chainMethod: $('#chain-method'),
  chainTopnav: $('#chain-topnav'),
  chainTopUrl: $('#chain-top-url'),
  chainBlock3p: $('#chain-block-3p'),
  chainSteps: $('#chain-steps'),
  chainAddStep: $('#chain-add-step'),
  chainRun: $('#chain-run'),
  chainDemo: $('#chain-demo'),
  chainResult: $('#chain-result'),

  resetBtn: $('#reset-btn'),
  jarCount: $('#jar-count-num'),
  jarWrap: $('#jar-table-wrap'),
  jarEmpty: $('#jar-empty'),

  snapshotDownload: $('#snapshot-download'),
  snapshotImport: $('#snapshot-import'),
  snapshotFile: $('#snapshot-file'),
  snapshotResult: $('#snapshot-result'),

  clockNow: $('#clock-now'),
  clockMeta: $('#clock-meta'),
  clockSeconds: $('#clock-seconds'),
  clockAdvance: $('#clock-advance'),
  clockResult: $('#clock-result'),

  capGlobal: $('#cap-global'),
  capAdd: $('#cap-add'),
  capDomains: $('#cap-domains'),
  capUsage: $('#cap-usage'),
  capSave: $('#cap-save'),
  capClear: $('#cap-clear'),
  capResult: $('#cap-result'),

  scriptUrl: $('#script-url'),
  scriptTopUrl: $('#script-top-url'),
  scriptBlock3p: $('#script-block-3p'),
  scriptReadBtn: $('#script-read-btn'),
  scriptReadResult: $('#script-read-result'),
  scriptCookie: $('#script-cookie'),
  scriptWriteBtn: $('#script-write-btn'),
  scriptWriteResult: $('#script-write-result'),
  toast: null,
};

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`服务端返回异常（HTTP ${resp.status}）`);
  }
  if (!resp.ok && data && data.error) throw new Error(data.error);
  return data;
}

let toastTimer = null;
function toast(message) {
  if (!els.toast) {
    els.toast = document.createElement('div');
    els.toast.className = 'toast';
    document.body.appendChild(els.toast);
  }
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }
}

/* ---------- Cookie 罐表格 ---------- */

function sameSiteBadge(c) {
  const cls = c.sameSite === 'strict' ? 'ss-strict' : c.sameSite === 'none' ? 'ss-none' : 'ss-lax';
  return `<span class="badge ${cls}">SameSite=${escapeHtml(c.sameSiteLabel)}</span>`;
}

function priorityBadge(c) {
  const cls = c.priority === 'high' ? 'pr-high' : c.priority === 'low' ? 'pr-low' : 'pr-medium';
  return `<span class="badge ${cls}">Priority=${escapeHtml(c.priorityLabel)}</span>`;
}

function partitionBadge(c) {
  if (!c.partitioned) return '<span class="badge part-none">未分区</span>';
  return `<span class="badge part-on" title="分区键（scheme + 可注册域；IP、localhost 用完整主机）">` +
    `Partitioned · ${escapeHtml(c.partitionKey)}</span>`;
}

function renderJar(cookies) {
  els.jarCount.textContent = String(cookies.length);

  if (!cookies.length) {
    els.jarWrap.innerHTML =
      '<p class="empty-hint">罐子是空的，先在左侧写入一条 Set-Cookie。</p>';
    return;
  }

  const rows = cookies.map((c) => {
    const scopeBadge = c.hostOnly
      ? '<span class="badge host">host-only</span>'
      : '<span class="badge domain">domain</span>';
    const secureBadge = c.secure
      ? '<span class="badge secure">Secure</span>'
      : '';
    const httpBadge = c.httpOnly
      ? '<span class="badge http">HttpOnly</span>'
      : '';
    const lifeBadge = c.persistent
      ? `<span class="badge ${c.expired ? 'expired-b' : 'persist'}">` +
        `${c.expired ? '已过期' : '有效期 ' + c.remaining}</span>`
      : '<span class="badge session">会话</span>';
    const expiresLine = c.persistent
      ? `<div class="dim">过期：${escapeHtml(c.expiresAt)}</div>`
      : '<div class="dim">浏览器关闭即失效（本工具不自动清）</div>';

    return `
      <tr class="${c.expired ? 'expired' : ''}">
        <td class="dim">#${c.index}</td>
        <td class="mono">
          <span class="cookie-name">${escapeHtml(c.name)}</span>=<span class="cookie-value">${escapeHtml(c.value)}</span>
        </td>
        <td>
          ${scopeBadge}
          <div class="domain-val">${escapeHtml(c.domain)}</div>
          <div class="dim">${escapeHtml(c.scope)}</div>
        </td>
        <td class="mono">${escapeHtml(c.path)}</td>
        <td class="part-cell">
          ${partitionBadge(c)}
        </td>
        <td>
          ${secureBadge}${httpBadge}${sameSiteBadge(c)}${priorityBadge(c)}${lifeBadge}
          ${expiresLine}
          <div class="dim">创建：${escapeHtml(c.createdAt)}</div>
          <div class="dim">最近访问：${escapeHtml(c.lastAccessedAt)}</div>
        </td>
      </tr>`;
  }).join('');

  els.jarWrap.innerHTML = `
    <table class="jar-table">
      <thead>
        <tr>
          <th>#</th><th>Cookie</th><th>域 / 作用域</th><th>Path</th><th>分区</th><th>属性 / 有效期 / 访问</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function refreshJar() {
  const resp = await fetch('/api/jar');
  const data = await resp.json();
  renderJar(data.cookies || []);
  if (data.capacity) {
    renderCapacityUsage(data.capacity);
    syncCapacityInputs(data.capacity);
  }
  if (data.clock) renderClock(data.clock);
}

/* ---------- 场景快照：下载 / 导入 ---------- */

/** 快照文件名时间戳：YYYYMMDD-HHMMSS（本地时区），仅用于命名 */
function snapshotFileStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function renderSnapshotOk(data) {
  els.snapshotResult.classList.remove('hidden');
  const expiredCount = (data.jar || []).filter((c) => c.expired).length;
  const limitText = data.globalLimit === null ? '不限' : `全局上限 ${data.globalLimit}`;
  els.snapshotResult.innerHTML =
    `<div class="banner ok">
      <span class="banner-title">✅ 快照导入成功</span>${escapeHtml(data.message || '场景已恢复')}
    </div>
    <div class="dim">恢复条目 <strong>${data.restoredCount}</strong> 条（其中过期 ${expiredCount} 条，原样保留）· ` +
    `域级容量规则 <strong>${data.domainLimitCount}</strong> 条 · ${escapeHtml(limitText)} · ` +
    `演算时钟 <strong>${escapeHtml(data.clock ? data.clock.readable : '')}</strong>（起点 ${escapeHtml(data.clock ? data.clock.startedAtReadable : '')}）· ` +
    `下一创建序号 <strong>#${data.snapshot ? data.snapshot.nextIndex : ''}</strong></div>`;
}

function renderSnapshotError(message) {
  els.snapshotResult.classList.remove('hidden');
  els.snapshotResult.innerHTML =
    `<div class="banner bad"><span class="banner-title">⛔ 快照导入失败</span>${escapeHtml(message)}</div>`;
}

els.snapshotDownload.addEventListener('click', async () => {
  els.snapshotDownload.disabled = true;
  try {
    const resp = await fetch('/api/snapshot');
    if (!resp.ok) throw new Error(`下载失败（HTTP ${resp.status}）`);
    const data = await resp.json();
    const snapshot = data.snapshot;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cookie-jar-snapshot-${snapshotFileStamp(new Date(snapshot.exportedAt))}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    els.snapshotResult.classList.remove('hidden');
    els.snapshotResult.innerHTML =
      `<div class="banner ok"><span class="banner-title">⬇ 已导出场景快照</span>` +
      `版本 v${snapshot.version}：${snapshot.cookies.length} 条 Cookie（含分区键、创建序号与创建/最近访问时间）、` +
      `${snapshot.capacity.domainLimits.length} 条域级容量规则（全局${snapshot.capacity.globalLimit === null ? '不限' : `上限 ${snapshot.capacity.globalLimit}`}）、` +
      `演算时钟（起点 ${escapeHtml(data.clock ? data.clock.startedAtReadable : '')} → 当前 ${escapeHtml(data.clock ? data.clock.readable : '')}）、下一序号 #${snapshot.nextIndex}</div>`;
  } catch (err) {
    renderSnapshotError(err instanceof Error ? err.message : String(err));
  } finally {
    els.snapshotDownload.disabled = false;
  }
});

els.snapshotImport.addEventListener('click', () => {
  // 清空 value，使重复选择同一文件也能再次触发 change
  els.snapshotFile.value = '';
  els.snapshotFile.click();
});

els.snapshotFile.addEventListener('change', async () => {
  const file = els.snapshotFile.files && els.snapshotFile.files[0];
  if (!file) return;
  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (err) {
    renderSnapshotError(`文件 ${file.name} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）；导入已取消，旧罐、容量和时钟均不变`);
    return;
  }
  // 服务端做完整结构/时间/身份/序号校验；支持快照对象本身或 { snapshot } 包裹
  const candidate = parsed && typeof parsed === 'object' && 'snapshot' in parsed ? parsed.snapshot : parsed;
  els.snapshotImport.disabled = true;
  try {
    const data = await postJSON('/api/snapshot/import', candidate);
    renderSnapshotOk(data);
    // 导入结果刷新罐表、容量面板与时钟
    if (data.jar) renderJar(data.jar);
    if (data.capacity) {
      renderCapacityUsage(data.capacity);
      syncCapacityInputs(data.capacity);
    }
    if (data.clock) renderClock(data.clock);
    // 状态已整体替换，收起其它演算结果，避免与恢复后的场景错位
    els.storeResult.classList.add('hidden');
    els.sendResult.classList.add('hidden');
    els.chainResult.classList.add('hidden');
    els.capResult.classList.add('hidden');
    els.scriptReadResult.classList.add('hidden');
    els.scriptWriteResult.classList.add('hidden');
    els.clockResult.classList.add('hidden');
    toast(`快照已导入：${data.restoredCount} 条 Cookie，容量规则与时钟已恢复`);
  } catch (err) {
    renderSnapshotError(err instanceof Error ? err.message : String(err));
  } finally {
    els.snapshotImport.disabled = false;
  }
});

/* ---------- 演算时钟 ---------- */

function renderClock(clock) {
  els.clockNow.textContent = clock.readable;
  els.clockMeta.textContent =
    `启动时刻 ${clock.startedAtReadable} · 已推进 ${clock.elapsedSeconds} 秒`;
}

function renderClockError(message) {
  els.clockResult.classList.remove('hidden');
  els.clockResult.innerHTML =
    `<div class="banner bad"><span class="banner-title">⛔ 无法推进</span>${escapeHtml(message)}</div>`;
}

els.clockAdvance.addEventListener('click', async () => {
  const raw = els.clockSeconds.value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isSafeInteger(n) || n < 1) {
    renderClockError('推进秒数必须是不小于 1 的正整数（时钟与罐均未改动）');
    return;
  }
  els.clockAdvance.disabled = true;
  try {
    const data = await postJSON('/api/clock/advance', { seconds: n });
    if (data.clock) renderClock(data.clock);
    // 推进本身不删除条目，但过期/剩余展示随时间变化，需刷新罐表格与用量
    if (data.cookies) renderJar(data.cookies);
    if (data.capacity) renderCapacityUsage(data.capacity);
    els.clockResult.classList.remove('hidden');
    els.clockResult.innerHTML =
      `<div class="banner ok"><span class="banner-title">✅ 已推进 ${n} 秒</span>` +
      `当前演算时间 ${escapeHtml(data.clock ? data.clock.readable : '')}；` +
      `过期项仍留在罐中，下次匹配或容量淘汰时按既有规则处理</div>`;
  } catch (err) {
    renderClockError(err instanceof Error ? err.message : String(err));
  } finally {
    els.clockAdvance.disabled = false;
  }
});

els.clockSeconds.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.clockAdvance.click();
});

/* ---------- 写入结果 ---------- */

const STORE_BANNER = {
  stored:   { cls: 'ok',     title: '✅ 入罐成功' },
  updated:  { cls: 'update', title: '🔄 覆盖更新' },
  deleted:  { cls: 'delete', title: '🗑 执行删除' },
  rejected: { cls: 'bad',    title: '⛔ 拒绝入罐' },
};

function noticesHtml(notices) {
  if (!notices || !notices.length) return '';
  return `<ul class="notices">${notices
    .map((n) => `<li>⚠️ ${escapeHtml(n)}</li>`)
    .join('')}</ul>`;
}

/* ---------- 容量压力淘汰清单 ---------- */

function evictedItemHtml(item) {
  const prCls = item.priority === 'high' ? 'pr-high' : item.priority === 'low' ? 'pr-low' : 'pr-medium';
  const tag = item.reason === 'expired'
    ? '<span class="tag exclude">过期清理</span>'
    : '<span class="tag evict">容量淘汰</span>';
  return `
    <div class="item evicted">
      <div class="item-top">
        <span class="item-idx">#${item.index}</span>
        ${tag}
        <span class="item-cookie">${escapeHtml(item.cookie)}</span>
        <span class="badge ${prCls}">Priority=${escapeHtml(item.priorityLabel)}</span>
        ${item.partitioned
          ? `<span class="badge part-on">Partitioned · ${escapeHtml(item.partitionKey)}</span>`
          : '<span class="badge part-none">未分区</span>'}
        <span class="dim mono">${item.hostOnly ? 'host-only' : 'domain'} · ${escapeHtml(item.domain)} · ${escapeHtml(item.path)}</span>
      </div>
      <div class="item-detail">${escapeHtml(item.basis)}</div>
      <div class="dim">最近访问：${escapeHtml(item.lastAccessedAt)}</div>
    </div>`;
}

function evictionStageHtml(stage) {
  if (!stage.triggered) return '';
  const title = stage.scope === 'global'
    ? `🌐 全局淘汰（上限 ${stage.limit}）`
    : `🏷️ 域级淘汰 · ${escapeHtml(stage.domain)}（上限 ${stage.limit}）`;
  const summary = `范围内 ${stage.beforeCount} 条` +
    (stage.expiredRemoved ? ` → 先清理过期 ${stage.expiredRemoved} 条` : '') +
    (stage.evictedCount ? ` → 按序淘汰 ${stage.evictedCount} 条` : '') +
    ` → 剩 ${stage.afterCount} 条`;
  return `
    <div class="eviction-stage">
      <div class="group-title">${title}</div>
      <div class="dim">${summary}</div>
      <div class="item-list">${stage.removed.map(evictedItemHtml).join('')}</div>
    </div>`;
}

function evictionHtml(eviction) {
  if (!eviction || !eviction.triggered) return '';
  const stages = eviction.stages.map(evictionStageHtml).join('');
  if (!stages) return '';
  return `
    <div class="eviction-box">
      <div class="banner delete">
        <span class="banner-title">📉 本次入罐触发容量压力淘汰</span>
        淘汰顺序：先域级、后全局；每级先清理过期项，再按优先级淘汰
      </div>
      <div class="eviction-basis">排序依据：<strong>${escapeHtml(eviction.basis)}</strong></div>
      ${stages}
    </div>`;
}

function renderStoreResult(data, resultEl = els.storeResult) {
  const meta = STORE_BANNER[data.action] || STORE_BANNER.rejected;
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = `
    <div class="banner ${meta.cls}">
      <span class="banner-title">${meta.title}</span>${escapeHtml(data.reason)}
    </div>
    ${noticesHtml(data.notices)}
    ${evictionHtml(data.eviction)}`;
  if (data.jar) renderJar(data.jar);
  if (data.capacity) renderCapacityUsage(data.capacity);
}

/* ---------- document.cookie 脚本演算 ---------- */

function scriptItemHtml(item) {
  const ok = item.verdict === 'send';
  const partBadge = item.partitioned
    ? `<span class="badge part-on">Partitioned · ${escapeHtml(item.partitionKey)}</span>`
    : '';
  const httpBadge = item.httpOnly
    ? '<span class="badge http">HttpOnly</span>'
    : '';
  const tag = ok
    ? '<span class="tag send">可读</span>'
    : '<span class="tag exclude">不可读</span>';
  return `
    <div class="item ${ok ? 'sent' : 'excluded'}">
      <div class="item-top">
        <span class="item-idx">#${item.index}</span>
        ${tag}
        <span class="item-cookie">${escapeHtml(item.cookie)}</span>
        ${httpBadge}
        ${partBadge}
      </div>
      <div class="item-detail">${escapeHtml(item.detail)}</div>
    </div>`;
}

function renderScriptReadResult(data) {
  els.scriptReadResult.classList.remove('hidden');

  if (!data.ok) {
    els.scriptReadResult.innerHTML = `
      <div class="banner bad">
        <span class="banner-title">⛔ 无法演算</span>${escapeHtml(data.error || '页面 URL 非法')}
      </div>`;
    return;
  }

  const strVal = data.cookieString
    ? escapeHtml(data.cookieString)
    : '<span class="dim">（空：document.cookie 读不到任何 cookie）</span>';

  const readableHtml = data.readable.length
    ? `<div class="group-title">👁 可读项（${data.readable.length}，已按 Path 长度降序 / 创建顺序升序排列）</div>
       <div class="item-list">${data.readable.map(scriptItemHtml).join('')}</div>`
    : '<div class="group-title">👁 可读项<span class="count">（0）</span></div>';

  const excludedHtml = data.excluded.length
    ? `<div class="group-title">🚫 不可读项（${data.excluded.length}）</div>
       <div class="item-list">${data.excluded.map(scriptItemHtml).join('')}</div>`
    : '';

  const siteBadge = data.sameSiteContext
    ? '<span class="badge ss-same">同站</span>'
    : '<span class="badge ss-cross">跨站</span>';
  const blockBadge = data.blockThirdParty
    ? '<span class="badge ss-cross">屏蔽第三方 Cookie：开</span>'
    : '<span class="badge ss-same">屏蔽第三方 Cookie：关</span>';

  els.scriptReadResult.innerHTML = `
    <div class="meta-line">
      页面主机 <code>${escapeHtml(data.host)}</code> ·
      路径 <code>${escapeHtml(data.path)}</code> ·
      协议 <strong>${data.securePage ? 'https（可读 Secure）' : 'http（不读 Secure）'}</strong>
    </div>
    <div class="meta-line">
      页面站 <code>${escapeHtml(data.pageSite)}</code> vs 顶层站 <code>${escapeHtml(data.topSite)}</code>
      ${siteBadge} · ${blockBadge} · <span class="dim">document.cookie 读取不应用 SameSite、不刷新最近访问时间</span>
    </div>
    <div class="meta-line">
      🔑 页面分区键（顶层页面 URL 的 scheme + 可注册域）：<code>${escapeHtml(data.partitionKey)}</code>
    </div>
    <div class="header-block">
      <div class="header-line ${data.cookieString ? '' : 'empty'}">
        <span class="hname">document.cookie =</span>
        <span class="hval" id="script-cookie-val">${strVal}</span>
        ${data.cookieString ? '<button class="copy-btn" id="copy-script-cookie" type="button">复制</button>' : ''}
      </div>
    </div>
    ${readableHtml}
    ${excludedHtml}`;

  const copyBtn = $('#copy-script-cookie');
  if (copyBtn) copyBtn.addEventListener('click', () => copyText(data.cookieString));
}

/* ---------- 发送结果 ---------- */

function itemHtml(item) {
  const sent = item.verdict === 'send';
  const ssCls = item.sameSite === 'strict' ? 'ss-strict' : item.sameSite === 'none' ? 'ss-none' : 'ss-lax';
  const partBadge = item.partitioned
    ? `<span class="badge part-on">Partitioned · ${escapeHtml(item.partitionKey)}</span>`
    : '';
  return `
    <div class="item ${sent ? 'sent' : 'excluded'}">
      <div class="item-top">
        <span class="item-idx">#${item.index}</span>
        <span class="tag ${sent ? 'send' : 'exclude'}">${sent ? '发送' : '排除'}</span>
        <span class="item-cookie">${escapeHtml(item.cookie)}</span>
        <span class="badge ${ssCls}">SameSite=${escapeHtml(item.sameSiteLabel)}</span>
        ${partBadge}
      </div>
      <div class="item-detail">${escapeHtml(item.detail)}</div>
    </div>`;
}

function renderSendResult(data) {
  els.sendResult.classList.remove('hidden');

  if (!data.ok) {
    els.sendResult.innerHTML = `
      <div class="banner bad">
        <span class="banner-title">⛔ 无法演算</span>${escapeHtml(data.error || '请求 URL 非法')}
      </div>`;
    return;
  }

  const headerVal = data.cookieHeader
    ? escapeHtml(data.cookieHeader)
    : '<span class="dim">（空：没有任何可发送的 cookie）</span>';

  const sentHtml = data.sent.length
    ? `<div class="group-title">📤 发送项（${data.sent.length}，已按 Path 长度降序 / 创建顺序升序排列）</div>
       <div class="item-list">${data.sent.map(itemHtml).join('')}</div>`
    : '<div class="group-title">📤 发送项<span class="count">（0）</span></div>';

  const excludedHtml = data.excluded.length
    ? `<div class="group-title">🚫 排除项（${data.excluded.length}）</div>
       <div class="item-list">${data.excluded.map(itemHtml).join('')}</div>`
    : '';

  const siteBadge = data.sameSiteContext
    ? '<span class="badge ss-same">同站</span>'
    : '<span class="badge ss-cross">跨站</span>';
  const navText = data.topLevelNav ? '顶层导航' : '非顶层导航';
  const blockBadge = data.blockThirdParty
    ? '<span class="badge ss-cross">屏蔽第三方 Cookie：开</span>'
    : '<span class="badge ss-same">屏蔽第三方 Cookie：关</span>';

  els.sendResult.innerHTML = `
    <div class="meta-line">
      请求主机 <code>${escapeHtml(data.host)}</code> ·
      路径 <code>${escapeHtml(data.path)}</code> ·
      协议 <strong>${data.secureRequest ? 'https（可发 Secure）' : 'http（不发 Secure）'}</strong>
    </div>
    <div class="meta-line">
      请求站 <code>${escapeHtml(data.requestSite)}</code> vs 顶层站 <code>${escapeHtml(data.topSite)}</code>
      ${siteBadge} · 方法 <code>${escapeHtml(data.method)}</code> · ${navText} · ${blockBadge}
    </div>
    <div class="meta-line">
      🔑 请求分区键（顶层页面 URL 的 scheme + 可注册域）：<code>${escapeHtml(data.partitionKey)}</code>
      <span class="dim">仅分区键相同的 Partitioned 项发送</span>
    </div>
    <div class="header-block">
      <div class="header-line ${data.cookieHeader ? '' : 'empty'}">
        <span class="hname">Cookie:</span>
        <span class="hval" id="header-val">${headerVal}</span>
        ${data.cookieHeader ? '<button class="copy-btn" id="copy-header" type="button">复制</button>' : ''}
      </div>
    </div>
    ${sentHtml}
    ${excludedHtml}`;

  const copyBtn = $('#copy-header');
  if (copyBtn) copyBtn.addEventListener('click', () => copyText(data.cookieHeader));
}

/* ---------- 重定向链演算 ---------- */

const CHAIN_STATUS_OPTIONS = [301, 302, 303, 307, 308, 200];

/** 新增一个响应步骤行（重定向默认 302，末步手动选 200） */
function addChainStep(status = 302, location = '', setCookies = []) {
  const idx = els.chainSteps.children.length + 1;
  const row = document.createElement('div');
  row.className = 'chain-step';
  row.innerHTML = `
    <div class="chain-step-head">
      <span class="chain-step-no">第 ${idx} 步</span>
      <select class="chain-status">
        ${CHAIN_STATUS_OPTIONS.map((s) => `<option value="${s}"${s === status ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
      <input class="chain-location" type="text" spellcheck="false" autocomplete="off"
        placeholder="Location（重定向必填，可相对，如 /dashboard；200 留空）" value="${escapeHtml(location)}" />
      <button class="btn ghost tiny chain-del" type="button" title="删除该步骤">✕</button>
    </div>
    <div class="chain-cookies-wrap">
      <div class="chain-cookies"></div>
      <button class="btn ghost tiny chain-add-cookie" type="button">+ 添加 Set-Cookie</button>
    </div>`;

  const statusSel = row.querySelector('.chain-status');
  const locInput = row.querySelector('.chain-location');
  const cookiesBox = row.querySelector('.chain-cookies');

  /** 状态码联动：200 末态不需要 Location；其余为跳转 */
  function syncStatus() {
    const is200 = statusSel.value === '200';
    locInput.disabled = is200;
    locInput.placeholder = is200 ? '末跳 200：无需 Location（已禁用）' : 'Location（重定向必填，可相对，如 /dashboard）';
  }
  statusSel.addEventListener('change', syncStatus);

  function addCookieRow(value = '') {
    const line = document.createElement('div');
    line.className = 'chain-cookie-row';
    line.innerHTML = `
      <span class="chain-cookie-arrow">Set-Cookie</span>
      <input class="chain-cookie" type="text" spellcheck="false" autocomplete="off"
        placeholder="如：sid=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600" value="${escapeHtml(value)}" />
      <button class="btn ghost tiny chain-cookie-del" type="button" title="删除该 Set-Cookie">✕</button>`;
    line.querySelector('.chain-cookie-del').addEventListener('click', () => line.remove());
    cookiesBox.appendChild(line);
    return line;
  }

  setCookies.forEach((v) => addCookieRow(v));
  row.querySelector('.chain-add-cookie').addEventListener('click', () => addCookieRow());
  row.querySelector('.chain-del').addEventListener('click', () => {
    row.remove();
    renumberChainSteps();
  });

  els.chainSteps.appendChild(row);
  syncStatus();
  return row;
}

function renumberChainSteps() {
  [...els.chainSteps.children].forEach((row, i) => {
    row.querySelector('.chain-step-no').textContent = `第 ${i + 1} 步`;
  });
}

function collectChainSteps() {
  return [...els.chainSteps.children].map((row) => {
    const status = Number(row.querySelector('.chain-status').value);
    const location = row.querySelector('.chain-location').value.trim();
    const setCookies = [...row.querySelectorAll('.chain-cookie')]
      .map((input) => input.value.trim())
      .filter((v) => v !== '');
    const step = { status };
    if (location !== '') step.location = location;
    if (setCookies.length) step.setCookies = setCookies;
    return step;
  });
}

const STORE_TAG_CLS = {
  stored: 'send', updated: 'send', deleted: 'evict', rejected: 'exclude',
};
const STORE_TAG_TEXT = {
  stored: '入罐', updated: '更新', deleted: '删除', rejected: '拒绝',
};

function chainStoreHtml(s) {
  const tag = STORE_TAG_CLS[s.action] || 'exclude';
  const text = STORE_TAG_TEXT[s.action] || s.action;
  return `
    <div class="item ${s.action === 'rejected' ? 'excluded' : 'sent'}">
      <div class="item-top">
        <span class="tag ${tag}">${text}</span>
        <span class="item-cookie">${escapeHtml(s.setCookie)}</span>
      </div>
      <div class="item-detail">${escapeHtml(s.reason)}</div>
      ${noticesHtml(s.notices)}
      ${evictionHtml(s.eviction)}
    </div>`;
}

function chainHopHtml(h, total) {
  const isLast = h.hop === total;
  const statusCls = isLast ? 'ss-same' : 'ss-cross';
  const arrow = isLast
    ? `<span class="dim">终态，无下一跳</span>`
    : `<span class="dim">→ 下一跳 <code>${escapeHtml(h.nextUrl)}</code></span>`;
  const methodNote = h.methodNote ? `<div class="chain-method-note">🔀 ${escapeHtml(h.methodNote)}</div>` : '';

  // 复用单跳发送结果的逐项渲染（发送 / 排除），上下文精简为关键 meta
  const sentHtml = h.send.sent.length
    ? `<div class="group-title">📤 发送项（${h.send.sent.length}）</div>
       <div class="item-list">${h.send.sent.map(itemHtml).join('')}</div>`
    : '<div class="group-title">📤 发送项<span class="count">（0）</span></div>';
  const excludedHtml = h.send.excluded.length
    ? `<div class="group-title">🚫 排除项（${h.send.excluded.length}）</div>
       <div class="item-list">${h.send.excluded.map(itemHtml).join('')}</div>`
    : '';
  const headerVal = h.send.cookieHeader
    ? escapeHtml(h.send.cookieHeader)
    : '<span class="dim">（空：没有可发送的 cookie）</span>';

  const storesHtml = h.stores.length
    ? `<div class="group-title">📥 本跳 Set-Cookie 写入结果（${h.stores.length}，按响应顺序逐条处理）</div>
       <div class="item-list">${h.stores.map(chainStoreHtml).join('')}</div>`
    : '';

  const siteBadge = h.send.sameSiteContext
    ? '<span class="badge ss-same">同站</span>'
    : '<span class="badge ss-cross">跨站</span>';

  return `
    <details class="chain-hop" ${isLast ? ' open' : ''}>
      <summary class="chain-hop-summary">
        <span class="badge ${statusCls}">${h.status}</span>
        <span class="badge ss-lax">${escapeHtml(h.method)}</span>
        <code class="chain-hop-url">${escapeHtml(h.requestUrl)}</code>
        ${siteBadge}
        <span class="dim">Cookie ${h.send.cookieHeader ? h.send.sent.length : 0} 项 · Set-Cookie ${h.stores.length} 条</span>
      </summary>
      <div class="chain-hop-body">
        <div class="meta-line">
          ${isLast ? '' : `Location: <code>${escapeHtml(h.location)}</code> · `}${arrow}
        </div>
        ${methodNote}
        <div class="meta-line dim">
          请求站 <code>${escapeHtml(h.send.requestSite)}</code> vs 顶层站 <code>${escapeHtml(h.send.topSite)}</code>
          · 路径 <code>${escapeHtml(h.send.path)}</code>
          · ${h.send.secureRequest ? 'https' : 'http'}
          · ${h.send.topLevelNav ? '顶层导航' : '非顶层导航'}
          · 屏蔽第三方 Cookie：${h.send.blockThirdParty ? '开' : '关'}
          · 分区键 <code>${escapeHtml(h.send.partitionKey)}</code>
        </div>
        <div class="header-block">
          <div class="header-line ${h.send.cookieHeader ? '' : 'empty'}">
            <span class="hname">Cookie:</span>
            <span class="hval">${headerVal}</span>
          </div>
        </div>
        ${sentHtml}
        ${excludedHtml}
        ${storesHtml}
      </div>
    </details>`;
}

function renderChainResult(data) {
  els.chainResult.classList.remove('hidden');
  if (!data.ok) {
    els.chainResult.innerHTML = `
      <div class="banner bad">
        <span class="banner-title">⛔ 重定向链未执行</span>${escapeHtml(data.error || '参数有误')}
      </div>`;
    return;
  }
  const total = data.hops.length;
  const hopsHtml = data.hops.map((h) => chainHopHtml(h, total)).join('');
  els.chainResult.innerHTML = `
    <div class="banner ok">
      <span class="banner-title">✅ 重定向链演算完成（${total} 跳）</span>
      起始 <code>${escapeHtml(data.method)}</code> <code>${escapeHtml(data.startUrl)}</code>
      → 末跳 200；顶层页面 URL 全程固定为 <code>${escapeHtml(data.topUrl)}</code>
    </div>
    <div class="chain-hops">${hopsHtml}</div>`;
}

els.chainAddStep.addEventListener('click', () => {
  addChainStep(200, '', []);
});

els.chainRun.addEventListener('click', async () => {
  const startUrl = els.chainStartUrl.value.trim();
  const topUrl = els.chainTopUrl.value.trim();
  if (!startUrl) {
    renderChainResult({ ok: false, error: '请先填写起始 URL' });
    return;
  }
  if (!topUrl) {
    renderChainResult({ ok: false, error: '请先填写固定顶层页面 URL（重定向链每一跳都沿用它）' });
    return;
  }
  if (!els.chainSteps.children.length) {
    renderChainResult({ ok: false, error: '请至少添加一个响应步骤（末跳 200）' });
    return;
  }
  const steps = collectChainSteps();
  // 前端做一层轻校验，错误信息与服务端预校验保持一致
  if (steps[steps.length - 1].status !== 200) {
    renderChainResult({ ok: false, error: `末跳（第 ${steps.length} 步）必须是 200 且无需 Location` });
    return;
  }
  for (let i = 0; i < steps.length - 1; i += 1) {
    if (![301, 302, 303, 307, 308].includes(steps[i].status)) {
      renderChainResult({ ok: false, error: `第 ${i + 1} 步（非末跳）状态码必须是 301/302/303/307/308 之一` });
      return;
    }
    if (!steps[i].location) {
      renderChainResult({ ok: false, error: `第 ${i + 1} 步为 ${steps[i].status} 跳转，必须填写 Location` });
      return;
    }
  }
  els.chainRun.disabled = true;
  try {
    const data = await postJSON('/api/redirect-chain', {
      startUrl,
      method: els.chainMethod.value,
      topUrl,
      topLevelNav: els.chainTopnav.checked,
      blockThirdParty: els.chainBlock3p.checked,
      steps,
    });
    renderChainResult(data);
    // 链中的 send 刷新访问时间、store 改动罐，同步右侧罐表与容量用量
    if (data.cookies) renderJar(data.cookies);
    if (data.capacity) renderCapacityUsage(data.capacity);
  } catch (err) {
    renderChainResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    els.chainRun.disabled = false;
  }
});

els.chainDemo.addEventListener('click', () => {
  els.chainStartUrl.value = 'https://login.example.com/signin';
  els.chainMethod.value = 'POST';
  els.chainTopnav.checked = true;
  els.chainTopUrl.value = 'https://shop.example.com/home';
  els.chainBlock3p.checked = false;
  els.chainSteps.innerHTML = '';
  addChainStep(303, '/dashboard', ['sid=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600']);
  addChainStep(302, 'https://app.example.com/welcome', ['track=1; Domain=example.com; Path=/; Secure; SameSite=None']);
  addChainStep(200, '', ['ui=ready; Path=/; Secure']);
});

/* ---------- 事件 ---------- */

els.storeBtn.addEventListener('click', async () => {
  const url = els.storeUrl.value.trim();
  const setCookie = els.storeCookie.value.trim();
  const topUrl = els.storeTopUrl.value.trim();
  if (!url || !setCookie) {
    renderStoreResult({
      ok: false, action: 'rejected',
      reason: !url ? '请先填写响应 URL' : '请先填写单条 Set-Cookie',
      notices: [],
    });
    return;
  }
  els.storeBtn.disabled = true;
  try {
    const data = await postJSON('/api/store', {
      url,
      setCookie,
      topUrl,
      blockThirdParty: els.storeBlock3p.checked,
    });
    renderStoreResult(data);
  } catch (err) {
    renderStoreResult({
      ok: false, action: 'rejected',
      reason: err instanceof Error ? err.message : String(err),
      notices: [],
    });
  } finally {
    els.storeBtn.disabled = false;
  }
});

els.sendBtn.addEventListener('click', async () => {
  const url = els.sendUrl.value.trim();
  if (!url) {
    els.sendResult.classList.remove('hidden');
    els.sendResult.innerHTML = `
      <div class="banner bad"><span class="banner-title">⛔</span>请先填写请求 URL</div>`;
    return;
  }
  els.sendBtn.disabled = true;
  try {
    const data = await postJSON('/api/send', {
      url,
      topUrl: els.sendTopUrl.value.trim(),
      method: els.sendMethod.value,
      topLevelNav: els.sendTopnav.checked,
      blockThirdParty: els.sendBlock3p.checked,
    });
    renderSendResult(data);
    // 发送成功的条目刷新了最近访问时间，同步表格与容量用量
    if (data.cookies) renderJar(data.cookies);
    if (data.capacity) renderCapacityUsage(data.capacity);
  } catch (err) {
    renderSendResult({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    els.sendBtn.disabled = false;
  }
});

els.resetBtn.addEventListener('click', async () => {
  try {
    const data = await postJSON('/api/reset', {});
    renderJar([]);
    if (data.capacity) renderCapacityUsage(data.capacity);
    if (data.clock) renderClock(data.clock);
    els.storeResult.classList.add('hidden');
    els.sendResult.classList.add('hidden');
    els.chainResult.classList.add('hidden');
    els.capResult.classList.add('hidden');
    els.scriptReadResult.classList.add('hidden');
    els.scriptWriteResult.classList.add('hidden');
    els.clockResult.classList.add('hidden');
    els.snapshotResult.classList.add('hidden');
    els.storeCookie.value = '';
    toast('Cookie 罐已重置（容量设置保留，时钟回到启动时刻）');
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
});

/* ---------- 容量压力设置 ---------- */

function addCapDomainRow(domain = '', limit = '') {
  const row = document.createElement('div');
  row.className = 'cap-row';
  row.innerHTML = `
    <input class="cap-domain" type="text" spellcheck="false" autocomplete="off" placeholder="可注册域，如 example.com" value="${escapeHtml(domain)}" />
    <input class="cap-limit" type="text" inputmode="numeric" spellcheck="false" autocomplete="off" placeholder="上限，如 3" value="${escapeHtml(limit)}" />
    <button class="btn ghost tiny cap-del" type="button" title="删除该行">✕</button>`;
  row.querySelector('.cap-del').addEventListener('click', () => {
    row.remove();
  });
  els.capDomains.appendChild(row);
  return row;
}

/** 服务端配置回填：仅在用户尚未输入过时同步，避免覆盖正在编辑的内容 */
function syncCapacityInputs(capacity) {
  if (els.capGlobal.dataset.touched !== '1') {
    els.capGlobal.value = capacity.globalLimit === null || capacity.globalLimit === undefined ? '' : String(capacity.globalLimit);
  }
  const configured = new Map((capacity.domainLimits || []).map((d) => [d.domain, String(d.limit)]));
  const rows = [...els.capDomains.querySelectorAll('.cap-row')];
  rows.forEach((row) => {
    const dInput = row.querySelector('.cap-domain');
    const lInput = row.querySelector('.cap-limit');
    const key = dInput.value.trim().toLowerCase().replace(/^\./, '');
    if (configured.has(key) && lInput.dataset.touched !== '1') {
      lInput.value = configured.get(key);
    }
    configured.delete(key);
  });
  // 服务端有、界面没有的已配置域（且界面没有同域名的空行）补一行
  for (const [domain, limit] of configured.entries()) {
    addCapDomainRow(domain, limit);
  }
}

function renderCapacityUsage(capacity) {
  const global = capacity.globalLimit === null || capacity.globalLimit === undefined
    ? '不限'
    : `${capacity.totalCount}/${capacity.globalLimit}`;
  const globalCls = capacity.globalLimit && capacity.totalCount >= capacity.globalLimit ? 'over' : '';
  const usage = (capacity.usage || []);
  const rows = usage.map((u) => {
    const limitText = u.limit === null || u.limit === undefined ? '不限' : `${u.count}/${u.limit}`;
    const cls = u.limit !== null && u.limit !== undefined && u.count >= u.limit ? 'over' : '';
    return `<div class="cap-usage-row ${cls}">
      <span class="mono">${escapeHtml(u.domain)}</span>
      <span class="cap-usage-num">${limitText} 条</span>
    </div>`;
  }).join('');
  els.capUsage.innerHTML = `
    <div class="cap-usage-row cap-usage-global ${globalCls}">
      <span>全局用量</span><span class="cap-usage-num">${global} 条</span>
    </div>
    ${rows}`;
}

function renderCapacityResult(data) {
  els.capResult.classList.remove('hidden');
  if (!data.ok) {
    els.capResult.innerHTML =
      `<div class="banner bad"><span class="banner-title">⛔ 容量设置无效</span>${escapeHtml(data.error || '参数有误')}</div>`;
    return;
  }
  const ev = data.eviction;
  const removed = ev && ev.removed ? ev.removed.length : 0;
  const banner = removed > 0
    ? `<div class="banner delete"><span class="banner-title">📉 设置已应用并立即淘汰 ${removed} 条</span>详见下方清单与排序依据</div>`
    : '<div class="banner ok"><span class="banner-title">✅ 容量设置已应用</span>当前各范围均未超限（未触发清理/淘汰）</div>';
  els.capResult.innerHTML = `${banner}${evictionHtml(ev)}`;
}

els.capAdd.addEventListener('click', () => addCapDomainRow());

els.capGlobal.addEventListener('input', () => { els.capGlobal.dataset.touched = '1'; });

els.capSave.addEventListener('click', async () => {
  const globalRaw = els.capGlobal.value.trim();
  const body = { globalLimit: globalRaw === '' ? null : Number(globalRaw), domainLimits: {} };

  const rows = [...els.capDomains.querySelectorAll('.cap-row')];
  for (const row of rows) {
    const domain = row.querySelector('.cap-domain').value.trim().toLowerCase().replace(/^\./, '');
    const limitRaw = row.querySelector('.cap-limit').value.trim();
    if (domain === '' && limitRaw === '') continue;
    if (domain === '') {
      renderCapacityResult({ ok: false, error: '有一行填写了上限却没填域名，请补可注册域（如 example.com）或删除该行' });
      els.capResult.classList.remove('hidden');
      return;
    }
    if (limitRaw === '') continue; // 只填域名不填上限 = 该域不限制，提交时忽略
    body.domainLimits[domain] = Number(limitRaw);
  }

  els.capSave.disabled = true;
  try {
    const data = await postJSON('/api/capacity', body);
    renderCapacityResult(data);
    if (data.capacity) {
      renderCapacityUsage(data.capacity);
      syncCapacityInputs(data.capacity);
    }
    if (data.cookies) renderJar(data.cookies);
  } catch (err) {
    renderCapacityResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    els.capSave.disabled = false;
  }
});

els.capClear.addEventListener('click', async () => {
  els.capGlobal.value = '';
  els.capDomains.innerHTML = '';
  addCapDomainRow();
  try {
    const data = await postJSON('/api/capacity', { globalLimit: null, domainLimits: {} });
    renderCapacityResult(data);
    if (data.capacity) renderCapacityUsage(data.capacity);
    toast('已取消全部容量限制');
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
});

// 标记上限输入框被手动编辑过（避免服务端回填覆盖）
els.capDomains.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('cap-limit')) {
    e.target.dataset.touched = '1';
  }
});

/* ---------- document.cookie 脚本演算事件 ---------- */

els.scriptReadBtn.addEventListener('click', async () => {
  const url = els.scriptUrl.value.trim();
  if (!url) {
    els.scriptReadResult.classList.remove('hidden');
    els.scriptReadResult.innerHTML =
      '<div class="banner bad"><span class="banner-title">⛔</span>请先填写页面 URL</div>';
    return;
  }
  els.scriptReadBtn.disabled = true;
  try {
    // 纯只读：不刷新最近访问时间，也不要求界面同步罐表格
    const data = await postJSON('/api/script/read', {
      url,
      topUrl: els.scriptTopUrl.value.trim(),
      blockThirdParty: els.scriptBlock3p.checked,
    });
    renderScriptReadResult(data);
  } catch (err) {
    renderScriptReadResult({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    els.scriptReadBtn.disabled = false;
  }
});

els.scriptWriteBtn.addEventListener('click', async () => {
  const url = els.scriptUrl.value.trim();
  const setCookie = els.scriptCookie.value.trim();
  if (!url || !setCookie) {
    renderStoreResult(
      {
        ok: false, action: 'rejected',
        reason: !url ? '请先填写页面 URL' : '请先填写 document.cookie 赋值串',
        notices: [],
      },
      els.scriptWriteResult,
    );
    return;
  }
  els.scriptWriteBtn.disabled = true;
  try {
    const data = await postJSON('/api/script/write', {
      url,
      setCookie,
      topUrl: els.scriptTopUrl.value.trim(),
      blockThirdParty: els.scriptBlock3p.checked,
    });
    renderStoreResult(data, els.scriptWriteResult);
  } catch (err) {
    renderStoreResult(
      {
        ok: false, action: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
        notices: [],
      },
      els.scriptWriteResult,
    );
  } finally {
    els.scriptWriteBtn.disabled = false;
  }
});

/* 回车快捷提交：脚本面板 */
els.scriptUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.scriptReadBtn.click();
});
els.scriptTopUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.scriptReadBtn.click();
});
els.scriptCookie.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.scriptWriteBtn.click();
});

addCapDomainRow();

els.fillDemo.addEventListener('click', () => {
  els.storeUrl.value = 'https://shop.example.com/admin/dashboard?tab=1';
  els.storeTopUrl.value = 'https://embed.example.net/';
  els.storeCookie.value = 'session=abc123; Domain=example.com; Path=/; Max-Age=3600; Secure; SameSite=Lax; Priority=High; Partitioned';
  els.sendUrl.value = 'https://api.shop.example.com/orders/123/detail';
  els.sendTopUrl.value = 'https://embed.example.net/page';
  els.sendMethod.value = 'GET';
  els.sendTopnav.checked = true;
  els.scriptUrl.value = 'https://shop.example.com/admin/dashboard';
  els.scriptTopUrl.value = 'https://embed.example.net/page';
  els.scriptCookie.value = 'uiTheme=dark; Path=/; Max-Age=3600; Secure';
});

/* 回车快捷提交 */
els.storeCookie.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.storeBtn.click();
});
els.storeUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.storeBtn.click();
});
els.storeTopUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.storeBtn.click();
});
els.sendUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.sendBtn.click();
});
els.sendTopUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.sendBtn.click();
});
els.chainStartUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.chainRun.click();
});
els.chainTopUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.chainRun.click();
});

/* 初始加载 */
addChainStep(302, '', []);
addChainStep(200, '', []);
refreshJar().catch((err) => console.error(err));
