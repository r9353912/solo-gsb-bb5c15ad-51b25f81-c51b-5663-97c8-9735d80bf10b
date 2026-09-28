/**
 * server.ts —— HTTP Cookie 罐演算 Web 服务
 *
 * 接口：
 *   GET  /                       原生前端页面（public/）
 *   GET  /api/jar                当前内存罐快照（含容量设置与各可注册域用量）
 *   POST /api/store              { url, setCookie, topUrl?, blockThirdParty? } 顺序处理一次 Set-Cookie 写入（含容量压力淘汰）；
 *                                topUrl 为顶层页面 URL，仅 Partitioned cookie 必需（计算分区键）；
 *                                blockThirdParty=true 开启「屏蔽第三方 Cookie」：topUrl 必填，
 *                                跨站响应拒绝写入/删除普通 Cookie（Partitioned 分区项不受此限）
 *   POST /api/send               { url, topUrl?, method?, topLevelNav?, blockThirdParty? } 演算请求 Cookie 头；
 *                                blockThirdParty=true 时 topUrl 必填，跨站请求排除普通 Cookie
 *                                （分区键匹配的 Partitioned 项仍可发送）
 *   POST /api/redirect-chain     { startUrl, method?, topUrl, topLevelNav?, blockThirdParty?,
 *                                  steps: [{ status, location?, setCookies?[] }] }（最多 8 步）
 *                                演算整条重定向链：每跳先按现有规则生成 Cookie 头，再按响应 URL
 *                                顺序写入该跳的 Set-Cookie 列表；303 之后改 GET（HEAD 保留），
 *                                301/302 仅 POST 改 GET，307/308 保留方法；相对 Location 基于
 *                                当前 URL 解析；顶层页面 URL / 顶层导航 / 第三方屏蔽整条链沿用。
 *                                先完整预校验（起始/顶层 URL、每跳 http(s) 目标、状态码与 Location
 *                                组合、Set-Cookie 列表类型），失败返回 400 且罐保持不变。
 *                                末跳必须为 200 且无 Location。
 *   POST /api/script/read        { url, topUrl?, blockThirdParty? } 演算页面脚本读取 document.cookie：
 *                                按既有 过期/分区/第三方屏蔽/Domain/Path/Secure 筛选，再排除 HttpOnly；
 *                                不应用 SameSite，不刷新最近访问时间，沿用请求头排序并逐项说明原因
 *   POST /api/script/write       { url, setCookie, topUrl?, blockThirdParty? } 演算 document.cookie 赋值：
 *                                复用既有解析/分区身份/容量逻辑；拒绝带 HttpOnly 的赋值，
 *                                以及对同身份未过期 HttpOnly 项的覆盖或 Max-Age 删除
 *                                （拒绝时罐内容、时间戳、容量不变；网络接口 /api/store 不受此限）
 *   POST /api/capacity           { globalLimit?, domainLimits? } 设置全局/每可注册域容量并立即执行淘汰
 *   GET  /api/snapshot           下载场景快照（带 format/version：原始 Cookie 条目（含分区键、
 *                                创建序号与创建/最近访问时间）、容量规则、时钟起点与当前值、下一序号）
 *   POST /api/snapshot/import    导入场景快照（body 为快照对象本身，或 { snapshot } 包裹）：
 *                                先完整校验结构/时间范围/条目身份唯一性/序号一致性，
 *                                通过后一次性替换罐、容量与时钟；任一校验失败返回 400，
 *                                旧罐、容量和时钟均不变；恢复不执行淘汰，过期项原样保留
 *   GET  /api/clock              读取演算时钟（当前演算时间、启动时刻、已推进秒数）
 *   POST /api/clock/advance      { seconds } 以正整数秒推进演算时钟；非法输入（缺省、0、负数、
 *                                非整数、非数字）返回 400，时钟与罐均不变；推进本身不删除条目，
 *                                过期项留待下次匹配或容量淘汰按既有规则处理
 *   POST /api/reset              清空内存罐（容量设置保留；演算时钟同步回到服务启动时刻）
 *
 * 演算时钟：服务启动时固定当前真实时间为起点，之后只经 /api/clock/advance 推进；
 * 网络写入/发送、document.cookie 读写、罐快照与容量淘汰统一使用该时钟，
 * Max-Age 过期、默认 Lax 的 120 秒跨站顶层 POST 宽限与过期清理均可逐步复现。
 *
 * Cookie 状态全部保存在进程内存中，重启 / 重置即清空。
 */
import express from 'express';
import path from 'path';
import { CookieJar } from './cookieJar';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// JSON 解析失败（非法 JSON / 体积超限）统一返回 JSON 400，而不是 Express 默认的 HTML 错误页
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent || req.method === 'GET') {
    next(err);
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ ok: false, error: `请求体不是合法 JSON（${err.message}）；导入已取消，旧罐、容量和时钟均不变` });
    return;
  }
  if (err instanceof Error && (err as { type?: string }).type === 'entity.too.large') {
    res.status(400).json({ ok: false, error: '快照体积超过 2MB 上限；导入已取消，旧罐、容量和时钟均不变' });
    return;
  }
  next(err);
});

// 全局唯一的内存 Cookie 罐（演示用，单实例即可）
const jar = new CookieJar();

interface StoreBody {
  url?: unknown;
  setCookie?: unknown;
  topUrl?: unknown;
  blockThirdParty?: unknown;
}

app.post('/api/store', (req, res) => {
  const { url, setCookie, topUrl, blockThirdParty } = (req.body ?? {}) as StoreBody;
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少响应 URL（字段 url）' });
    return;
  }
  if (typeof setCookie !== 'string' || setCookie.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少单条 Set-Cookie（字段 setCookie），一次只能提交一条' });
    return;
  }
  if (topUrl !== undefined && typeof topUrl !== 'string') {
    res.status(400).json({ ok: false, error: '顶层页面 URL（字段 topUrl）必须是字符串' });
    return;
  }
  if (blockThirdParty !== undefined && typeof blockThirdParty !== 'boolean') {
    res.status(400).json({ ok: false, error: '屏蔽第三方 Cookie 开关（字段 blockThirdParty）必须是布尔值' });
    return;
  }
  const topUrlTrimmed = typeof topUrl === 'string' ? topUrl.trim() : '';
  // 仅带 Partitioned 的 Set-Cookie 才使用 topUrl 计算分区键；
  // 开启 blockThirdParty 时 topUrl 还是跨站判定基准（此时普通 cookie 也用它）
  const result = jar.store(
    url.trim(),
    setCookie,
    topUrlTrimmed === '' ? undefined : topUrlTrimmed,
    { blockThirdParty: blockThirdParty === true },
  );
  res.json({ ...result, capacity: jar.capacity() });
});

interface SendBody {
  url?: unknown;
  topUrl?: unknown;
  method?: unknown;
  topLevelNav?: unknown;
  blockThirdParty?: unknown;
}

app.post('/api/send', (req, res) => {
  const { url, topUrl, method, topLevelNav, blockThirdParty } = (req.body ?? {}) as SendBody;
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少请求 URL（字段 url）' });
    return;
  }
  if (topUrl !== undefined && typeof topUrl !== 'string') {
    res.status(400).json({ ok: false, error: '顶层页面 URL（字段 topUrl）必须是字符串' });
    return;
  }
  if (method !== undefined && typeof method !== 'string') {
    res.status(400).json({ ok: false, error: '请求方法（字段 method）必须是字符串' });
    return;
  }
  if (topLevelNav !== undefined && typeof topLevelNav !== 'boolean') {
    res.status(400).json({ ok: false, error: '是否顶层导航（字段 topLevelNav）必须是布尔值' });
    return;
  }
  if (blockThirdParty !== undefined && typeof blockThirdParty !== 'boolean') {
    res.status(400).json({ ok: false, error: '屏蔽第三方 Cookie 开关（字段 blockThirdParty）必须是布尔值' });
    return;
  }
  const result = jar.send(url.trim(), {
    topUrl: typeof topUrl === 'string' && topUrl.trim() !== '' ? topUrl.trim() : undefined,
    method: typeof method === 'string' && method.trim() !== '' ? method.trim() : undefined,
    topLevelNav,
    blockThirdParty: blockThirdParty === true,
  });
  // 发送成功的条目会刷新最近访问时间，故把最新罐内容与用量一并返回
  res.json({ ...result, capacity: jar.capacity(), cookies: jar.list() });
});

interface RedirectChainBody {
  startUrl?: unknown;
  method?: unknown;
  topUrl?: unknown;
  topLevelNav?: unknown;
  blockThirdParty?: unknown;
  steps?: unknown;
}

interface RawStep {
  status: unknown;
  location?: unknown;
  setCookies?: unknown;
}

app.post('/api/redirect-chain', (req, res) => {
  const body = (req.body ?? {}) as RedirectChainBody;

  // ---- 结构校验（类型层面的预校验在 server 层；URL/状态码/Location 语义校验在罐内，全部先于任何罐改动）----
  if (typeof body.startUrl !== 'string' || body.startUrl.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少起始 URL（字段 startUrl）；罐保持不变' });
    return;
  }
  if (body.method !== undefined && typeof body.method !== 'string') {
    res.status(400).json({ ok: false, error: '请求方法（字段 method）必须是字符串；罐保持不变' });
    return;
  }
  if (typeof body.topUrl !== 'string' || body.topUrl.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少固定顶层页面 URL（字段 topUrl，http(s)）：重定向链每一跳都沿用它；罐保持不变' });
    return;
  }
  if (body.topLevelNav !== undefined && typeof body.topLevelNav !== 'boolean') {
    res.status(400).json({ ok: false, error: '是否顶层导航（字段 topLevelNav）必须是布尔值；罐保持不变' });
    return;
  }
  if (body.blockThirdParty !== undefined && typeof body.blockThirdParty !== 'boolean') {
    res.status(400).json({ ok: false, error: '屏蔽第三方 Cookie 开关（字段 blockThirdParty）必须是布尔值；罐保持不变' });
    return;
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    res.status(400).json({ ok: false, error: '缺少响应步骤（字段 steps 必须是非空数组）；罐保持不变' });
    return;
  }
  if (body.steps.length > 8) {
    res.status(400).json({ ok: false, error: `响应步骤最多 8 个（当前 ${body.steps.length} 个）；罐保持不变` });
    return;
  }

  const steps = [];
  for (let i = 0; i < body.steps.length; i += 1) {
    const raw = body.steps[i] as Partial<RawStep> | null;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      res.status(400).json({ ok: false, error: `第 ${i + 1} 步必须是对象（含 status，可选 location / setCookies）；罐保持不变` });
      return;
    }
    // 状态码：数字或数字字符串都接受（必须是整数）
    const statusN = typeof raw.status === 'string' ? Number(raw.status.trim()) : raw.status;
    if (typeof statusN !== 'number' || !Number.isInteger(statusN) || statusN < 100 || statusN > 599) {
      res.status(400).json({ ok: false, error: `第 ${i + 1} 步状态码（字段 status）必须是 100~599 的整数；罐保持不变` });
      return;
    }
    if (raw.location !== undefined && typeof raw.location !== 'string') {
      res.status(400).json({ ok: false, error: `第 ${i + 1} 步 Location 必须是字符串（可相对，留空表示无）；罐保持不变` });
      return;
    }
    if (raw.setCookies !== undefined && !Array.isArray(raw.setCookies)) {
      res.status(400).json({ ok: false, error: `第 ${i + 1} 步 setCookies 必须是字符串数组；罐保持不变` });
      return;
    }
    const step: { status: number; location?: string; setCookies?: string[] } = { status: statusN };
    if (raw.location !== undefined) step.location = raw.location;
    if (raw.setCookies !== undefined) {
      if ((raw.setCookies as unknown[]).some((c) => typeof c !== 'string')) {
        res.status(400).json({ ok: false, error: `第 ${i + 1} 步 setCookies 数组的每一项都必须是字符串；罐保持不变` });
        return;
      }
      step.setCookies = raw.setCookies as string[];
    }
    steps.push(step);
  }

  // 语义预校验（URL / 状态码组合 / 每跳目标）全部在罐内完成：失败不做任何 send 刷新或写入
  const result = jar.runRedirectChain({
    startUrl: body.startUrl.trim(),
    method: typeof body.method === 'string' && body.method.trim() !== '' ? body.method.trim() : undefined,
    topUrl: body.topUrl.trim(),
    topLevelNav: body.topLevelNav,
    blockThirdParty: body.blockThirdParty === true,
    steps,
  });
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  // 链执行中 send 会刷新最近访问时间、store 会改动罐，附最新全罐与用量
  res.json({ ...result, cookies: jar.list(), capacity: jar.capacity() });
});

interface ScriptReadBody {
  url?: unknown;
  topUrl?: unknown;
  blockThirdParty?: unknown;
}

app.post('/api/script/read', (req, res) => {
  const { url, topUrl, blockThirdParty } = (req.body ?? {}) as ScriptReadBody;
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少页面 URL（字段 url）' });
    return;
  }
  if (topUrl !== undefined && typeof topUrl !== 'string') {
    res.status(400).json({ ok: false, error: '顶层页面 URL（字段 topUrl）必须是字符串' });
    return;
  }
  if (blockThirdParty !== undefined && typeof blockThirdParty !== 'boolean') {
    res.status(400).json({ ok: false, error: '屏蔽第三方 Cookie 开关（字段 blockThirdParty）必须是布尔值' });
    return;
  }
  // 纯只读：不刷新最近访问时间、不改动罐内容，故不回写 cookies（仍附 capacity 供界面展示用量）
  const result = jar.readDocumentCookie(url.trim(), {
    topUrl: typeof topUrl === 'string' && topUrl.trim() !== '' ? topUrl.trim() : undefined,
    blockThirdParty: blockThirdParty === true,
  });
  res.json({ ...result, capacity: jar.capacity() });
});

app.post('/api/script/write', (req, res) => {
  const { url, setCookie, topUrl, blockThirdParty } = (req.body ?? {}) as StoreBody;
  if (typeof url !== 'string' || url.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少页面 URL（字段 url）' });
    return;
  }
  if (typeof setCookie !== 'string' || setCookie.trim() === '') {
    res.status(400).json({ ok: false, error: '缺少 document.cookie 赋值串（字段 setCookie），一次只能提交一条' });
    return;
  }
  if (topUrl !== undefined && typeof topUrl !== 'string') {
    res.status(400).json({ ok: false, error: '顶层页面 URL（字段 topUrl）必须是字符串' });
    return;
  }
  if (blockThirdParty !== undefined && typeof blockThirdParty !== 'boolean') {
    res.status(400).json({ ok: false, error: '屏蔽第三方 Cookie 开关（字段 blockThirdParty）必须是布尔值' });
    return;
  }
  const topUrlTrimmed = typeof topUrl === 'string' ? topUrl.trim() : '';
  // fromScript=true：复用既有解析 / 分区身份 / 容量逻辑，追加 document.cookie 的 HttpOnly 保护
  const result = jar.store(
    url.trim(),
    setCookie,
    topUrlTrimmed === '' ? undefined : topUrlTrimmed,
    { blockThirdParty: blockThirdParty === true, fromScript: true },
  );
  res.json({ ...result, capacity: jar.capacity() });
});

interface CapacityBody {
  globalLimit?: unknown;
  domainLimits?: unknown;
}

/** 容量上限值校验：正整数（>=1）才合法；null/缺省表示不限 */
function parseLimit(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  // JSON 里数字或数字字符串都接受
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error(`${field} 必须是不小于 1 的正整数（留空表示不限制）`);
  }
  return n;
}

app.post('/api/capacity', (req, res) => {
  const { globalLimit, domainLimits } = (req.body ?? {}) as CapacityBody;

  let global: number | null;
  try {
    global = parseLimit(globalLimit, '全局容量');
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
    return;
  }

  if (domainLimits !== undefined && (typeof domainLimits !== 'object' || domainLimits === null || Array.isArray(domainLimits))) {
    res.status(400).json({ ok: false, error: '域级容量（字段 domainLimits）必须是 { "可注册域": 上限 } 的对象' });
    return;
  }

  const limits: Record<string, number> = {};
  const entries = (domainLimits ?? {}) as Record<string, unknown>;
  for (const [rawDomain, rawLimit] of Object.entries(entries)) {
    const domain = rawDomain.trim().toLowerCase().replace(/^\./, '');
    if (domain === '') {
      res.status(400).json({ ok: false, error: '域级容量存在空的域名，请填写可注册域（例如 example.com）或删除该行' });
      return;
    }
    try {
      const limit = parseLimit(rawLimit, `域 ${domain} 的容量`);
      if (limit !== null) limits[domain] = limit;
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
      return;
    }
  }

  const result = jar.setCapacity({ globalLimit: global, domainLimits: limits });
  res.json({ ok: true, ...result, cookies: jar.list() });
});

app.get('/api/jar', (_req, res) => {
  res.json({ ok: true, cookies: jar.list(), capacity: jar.capacity(), clock: jar.clock() });
});

// 场景快照下载：返回带 format/version 的完整状态（原始条目 + 容量规则 + 时钟 + 下一序号）
app.get('/api/snapshot', (_req, res) => {
  const snapshot = jar.snapshot();
  res.json({
    ok: true,
    snapshot,
    // 便于界面直接展示
    cookieCount: snapshot.cookies.length,
    clock: jar.clock(),
    capacity: jar.capacity(),
  });
});

// 场景快照导入：body 可以是快照对象本身，也可以是 { snapshot: {...} }
app.post('/api/snapshot/import', (req, res) => {
  const body = req.body ?? {};
  const candidate = typeof body === 'object' && body !== null && 'snapshot' in body
    ? (body as { snapshot: unknown }).snapshot
    : body;
  try {
    const result = jar.importSnapshot(candidate);
    res.status(200).json({
      ...result,
      message:
        `场景快照已导入并一次性替换全部状态：恢复 ${result.restoredCount} 条 Cookie` +
        `（过期项原样保留）、${result.domainLimitCount} 条域级容量规则` +
        `（全局${result.globalLimit === null ? '不限' : `上限 ${result.globalLimit}`}），` +
        `演算时钟恢复到 ${result.clock.readable}；后续发送排序、默认 Lax 宽限与容量淘汰与导出前连续操作一致`,
    });
  } catch (err) {
    // 完整校验未通过：旧罐、容量和时钟均不变
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/clock', (_req, res) => {
  res.json({ ok: true, clock: jar.clock() });
});

interface ClockAdvanceBody {
  seconds?: unknown;
}

/** 推进秒数校验：正整数（>=1）才合法；数字或数字字符串都接受 */
function parseAdvanceSeconds(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new Error('推进秒数（字段 seconds）必须是不小于 1 的正整数；时钟与罐均未改动');
  }
  return n;
}

app.post('/api/clock/advance', (req, res) => {
  const { seconds } = (req.body ?? {}) as ClockAdvanceBody;
  let n: number;
  try {
    n = parseAdvanceSeconds(seconds);
  } catch (err) {
    // 非法输入：400，时钟与罐均不变
    res.status(400).json({ ok: false, error: (err as Error).message });
    return;
  }
  const clock = jar.advance(n);
  // 推进本身不删除条目；仅时间变化，快照中的过期/剩余展示随之更新，故回传最新罐与用量
  res.json({ ok: true, clock, cookies: jar.list(), capacity: jar.capacity() });
});

app.post('/api/reset', (_req, res) => {
  jar.reset();
  res.json({
    ok: true,
    message: 'Cookie 罐已重置（内存已清空；容量设置保留；演算时钟已回到服务启动时刻）',
    cookies: [],
    capacity: jar.capacity(),
    clock: jar.clock(),
  });
});

// 兜底：未匹配的 /api 路径返回 JSON 404，其它路径交回前端首页
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🍪 Cookie Jar Lab 已启动：http://localhost:${PORT}`);
});
