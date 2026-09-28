/**
 * cookieJar.ts
 *
 * 内存 Cookie 罐的全部演算逻辑，规则对齐 RFC 6265（HTTP State Management Mechanism）：
 *
 *  写入（Set-Cookie）：
 *   - Domain 不匹配响应主机（不是主机本身、也不是其上级域）时拒绝；
 *   - 省略 Domain 时为 host-only cookie；带 Domain 时去掉前导点且为 Domain cookie；
 *   - Path 缺省取「响应 URL 路径最后一个斜杠之前的目录」（RFC 5.1.4 default-path）；
 *   - Max-Age <= 0（含 0、负数）删除同名 (name, domain, path) 项；
 *   - Max-Age 非法值时忽略（按会话 cookie 处理并给出提示）；
 *   - Secure cookie 在明文 http 响应里写入会给出提示（真实浏览器通常拒绝）；
 *   - SameSite 解析 Strict/Lax/None（大小写不敏感）；未声明或非法值记为默认 Lax；
 *     SameSite=None 未同时声明 Secure 时拒绝入罐。
 *   - Priority（RFC 6265bis）解析 Low/Medium/High（大小写不敏感）；缺省或非法值按 Medium 并提示。
 *   - Partitioned（CHIPS，RFC 6265bis 独立分区 cookie）：无值标志属性；
 *     仅当同时带 Secure、且写入时提供了有效的顶层页面 URL（http(s)）时才入罐，否则拒绝；
 *     分区键 = 顶层 URL 的 scheme + 可注册域（IP、localhost 用完整主机）。
 *     分区键是存储身份的一部分：普通项与不同分区的同名同域同路径项并存，
 *     覆盖更新与 Max-Age 删除都只影响对应分区。
 *   - 屏蔽第三方 Cookie（可选模式，默认关闭）：开启时必须提供有效顶层页面 URL，
 *     按 scheme + 可注册域判定响应站与顶层站是否跨站；跨站响应拒绝写入和删除
 *     普通 Cookie（不改动罐、不触发容量淘汰），Partitioned 分区项不受此限，
 *     仍按既有 Secure 与分区键规则处理。
 *
 *  容量压力模拟（入罐沿用上述全部校验通过后执行）：
 *   - 容量按「条目条数」计，可分别为每个可注册域（eTLD+1；IP/localhost 按完整主机）
 *     与全局设置上限，未设置表示不限；
 *   - 入罐（含覆盖更新）成功后依次执行「域级 → 全局」淘汰；修改容量设置时立即执行一次；
 *   - 仅当范围内条数超过上限才触发：先物理清理范围内已过期项，若仍超限，再按
 *     Priority 从低到高（Low→Medium→High）、最近访问时间从早到晚、创建序号从小到大
 *     依次淘汰，直到回到上限以内；
 *   - 被请求成功发送的条目更新最近访问时间（lastAccessedAt）。
 *
 *  发送（请求 URL + 顶层页面 URL + 方法 + 是否顶层导航）：
 *   - 已过期的不发送；
 *   - 分区 cookie（Partitioned）：请求分区键由顶层页面 URL（缺省取请求 URL）按
 *     scheme + 可注册域计算，仅分区键完全相同的分区项可发送；普通（未分区）项不带分区，照常参与；
 *   - host-only 仅精确匹配原主机；Domain cookie 匹配该域及其子域；IP 主机不做子域匹配；
 *   - Path 须相等，或以 cookie-path 开头且下一个字符是 "/"（path-match）；
 *   - Secure cookie 只通过 https: 请求发送；
 *   - SameSite 站点演算（same-site = scheme + 可注册域，公共后缀由 tldts/PSL 判定；
 *     IP 与 localhost 等无可注册域的主机按完整主机比较）：
 *       · Strict：仅同站发送；
 *       · 显式 Lax：同站，或跨站顶层导航的安全方法（GET/HEAD/OPTIONS/TRACE）；
 *       · 默认 Lax（未声明或非法值）：同上，另允许创建不超过 120 秒的跨站顶层 POST；
 *       · None：跨站照常发送（入罐时已强制要求 Secure）；
 *   - 屏蔽第三方 Cookie（可选模式，默认关闭）：开启时必须提供有效顶层页面 URL；
 *     跨站请求排除普通 Cookie（被排除条目不刷新最近访问时间），
 *     分区键匹配的 Partitioned 项不受此限，仍可发送；
 *   - 排序：Path 长度降序；相同长度按首次创建顺序（creation index）升序。
 *
 *  document.cookie 脚本演算（页面 JS 视角，与网络接口并列、规则不同）：
 *   - 读取（readDocumentCookie / POST /api/script/read；入参：页面 URL、顶层页面 URL、第三方屏蔽开关）：
 *     按既有「过期 → 分区 → 第三方屏蔽 → Domain → Path → Secure」顺序筛选，
 *     最后再排除 HttpOnly（document.cookie 对脚本不可见）；不应用 SameSite，
 *     不刷新最近访问时间（只读，不改罐内容）；排序沿用请求头（Path 长度降序、创建序号升序），
 *     逐项给出「可读 / 不可读」及原因，可读项以 "; " 拼成 document.cookie 字符串。
 *   - 写入（store(..., { fromScript: true }) / POST /api/script/write）：
 *     复用既有解析、分区身份与容量淘汰逻辑；但拒绝带 HttpOnly 的赋值，
 *     也拒绝覆盖或以 Max-Age<=0 删除「同身份（name, domain, path, 分区）且未过期」的 HttpOnly 项；
 *     所有脚本专属拒绝都在改动罐之前返回，罐内容、时间戳与容量保持不变。
 *     已过期的 HttpOnly 项不在保护之列（脚本赋值可正常顶替 / 删除）。
 *   - 网络接口（/api/store、/api/send）行为不变：照常写入、更新、删除并在请求头中发送 HttpOnly 项。
 *
 *  演算时钟（可控时间轴）：
 *   - 服务启动时把「当前真实时间」固定为演算时钟起点，之后不再随真实时间流动；
 *   - 只能经 POST /api/clock/advance 以正整数秒推进；非法输入（缺省、0、负数、
 *     非整数、非数字）被拒绝，时间与罐均不变；
 *   - 网络写入/发送、document.cookie 读写、罐快照与容量淘汰统一使用该时钟：
 *     Max-Age 过期、默认 Lax 的 120 秒跨站顶层 POST 宽限、过期清理都可逐步复现；
 *   - 推进本身不删除任何条目：过期项仍留在罐中（标灰展示），下次匹配或容量淘汰时
 *     再按既有规则处理；
 *   - 重置罐（POST /api/reset）时时钟同步回到启动时刻。
 *
 *  场景快照（GET /api/snapshot 下载、POST /api/snapshot/import 导入）：
 *   - 快照带格式标识与版本号，完整保存：原始 Cookie 条目（含分区键、创建序号、
 *     创建/更新/最近访问时间等全部字段）、容量规则（全局与每可注册域上限）、
 *     演算时钟起点与当前值、下一创建序号；
 *   - 导入先做完整校验（结构、时间范围、条目身份唯一性、序号一致性、枚举与布尔字段），
 *     任一不满足即拒绝；全部通过后才一次性替换罐内容、容量规则与时钟——
 *     失败时旧罐、容量和时钟均不变；
 *   - 恢复是精确状态替换：不执行容量淘汰，过期项原样保留；恢复后后续发送排序
 *     （Path 长度 / 创建序号）、默认 Lax 的 120 秒跨站顶层 POST 宽限（按创建时间）
 *     与容量淘汰（Priority / 最近访问 / 创建序号）均与导出前的连续操作完全一致。
 */
import { getDomain } from 'tldts';

/** SameSite 模式（存储时统一为小写） */
export type SameSiteMode = 'strict' | 'lax' | 'none';

/** Cookie Priority（RFC 6265bis，存储时统一为小写；缺省/非法一律 medium） */
export type CookiePriority = 'low' | 'medium' | 'high';

/** 罐中的单条 cookie（存储模型） */
export interface StoredCookie {
  name: string;
  value: string;
  /** 规范化为小写后的域。host-only 时为原主机；Domain cookie 时为属性域（无前导点） */
  domain: string;
  path: string;
  /** true = 仅精确匹配 domain 主机；false = 匹配 domain 及其子域 */
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  /** SameSite 模式；未声明或非法值一律记为 lax */
  sameSite: SameSiteMode;
  /** true = SameSite 为默认值（未声明或非法值）；默认 Lax 才享受 120 秒跨站顶层 POST 宽限 */
  sameSiteDefault: boolean;
  /** Cookie 优先级（容量淘汰依据）；缺省/非法一律 medium */
  priority: CookiePriority;
  /** true = Priority 为默认值（未声明或非法值） */
  priorityDefault: boolean;
  /** true = 独立分区 cookie（CHIPS，带 Partitioned 属性） */
  partitioned: boolean;
  /**
   * 分区键（仅 partitioned=true 时有效）：顶层站点 site = scheme + 可注册域
   * （IP、localhost 用完整主机）。它是存储身份的一部分。
   */
  partitionKey: string | null;
  /** 过期绝对时间戳（ms）；undefined 表示会话 cookie（本工具中永不过期，重启清空） */
  expiresAt?: number;
  /** 首次创建序号，从 1 开始；更新同名项时沿用，保证排序稳定 */
  creationIndex: number;
  /** 首次创建时间戳；更新同名项时保留（120 秒 Lax+POST 宽限也按它计算） */
  createdAt: number;
  /** 最近一次写入（创建或更新）的时间戳 */
  updatedAt: number;
  /** 最近一次访问时间戳：创建/更新时写入，发送成功时刷新（容量淘汰 LRA 依据） */
  lastAccessedAt: number;
}

/** 解析后的 Set-Cookie（单条） */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  maxAge?: number;
  /** 原始 Max-Age 是否非法（非法时忽略，按会话 cookie 处理） */
  maxAgeInvalid: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteMode;
  /** true = 未声明 SameSite 或值非法，按浏览器默认记为 Lax */
  sameSiteDefault: boolean;
  /** 原始 SameSite 值是否非法（非法时按默认 Lax 处理并给出提示） */
  sameSiteInvalid: boolean;
  priority: CookiePriority;
  /** true = 未声明 Priority 或值非法，按默认 Medium 处理 */
  priorityDefault: boolean;
  /** 原始 Priority 值是否非法（缺省不算非法，非法值才提示） */
  priorityInvalid: boolean;
  /** 是否声明 Partitioned（CHIPS，无值标志属性） */
  partitioned: boolean;
}

/** 前端表格 / API 共用的展示视图 */
export interface CookieView {
  index: number;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  scope: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteMode;
  sameSiteDefault: boolean;
  /** 展示用标签，例如 Strict / Lax（默认）/ None */
  sameSiteLabel: string;
  priority: CookiePriority;
  priorityDefault: boolean;
  /** 展示用标签：High / Medium（默认）/ Low */
  priorityLabel: string;
  /** 是否独立分区 cookie（CHIPS） */
  partitioned: boolean;
  /** 分区键（scheme + 可注册域；IP、localhost 用完整主机）；未分区为 null */
  partitionKey: string | null;
  /** 展示用标签：未分区 / 分区键 ... */
  partitionLabel: string;
  persistent: boolean;
  expiresAt: string | null;
  remaining: string | null;
  expired: boolean;
  createdAt: string;
  updatedAt: string;
  /** 最近访问时间（容量淘汰 LRA 依据）的可读描述 */
  lastAccessedAt: string;
}

export type StoreAction = 'stored' | 'updated' | 'deleted' | 'rejected';
export type ItemVerdict = 'send' | 'exclude';
export type EvictionScope = 'domain' | 'global';

/** 淘汰清单中的单条（过期清理与优先级淘汰共用） */
export interface EvictedCookie {
  index: number;
  name: string;
  value: string;
  cookie: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  priority: CookiePriority;
  priorityLabel: string;
  /** 是否独立分区 cookie（CHIPS） */
  partitioned: boolean;
  /** 分区键；未分区为 null */
  partitionKey: string | null;
  expired: boolean;
  /** 淘汰时的最近访问时间（可读） */
  lastAccessedAt: string;
  /** 淘汰原因：expired（过期清理）/ evicted（容量淘汰） */
  reason: 'expired' | 'evicted';
  /** 容量淘汰时命中的排序依据描述 */
  basis: string;
}

/** 单级淘汰（域级或全局）的完整报告 */
export interface EvictionStage {
  scope: EvictionScope;
  /** 域级淘汰时为该可注册域（IP/localhost 为完整主机）；全局为 null */
  domain: string | null;
  limit: number;
  /** 入罐前范围内条数 */
  beforeCount: number;
  /** 过期清理条数 */
  expiredRemoved: number;
  /** 按优先级淘汰条数 */
  evictedCount: number;
  /** 淘汰后范围内条数 */
  afterCount: number;
  /** 是否真正触发（清理或淘汰了任意条目） */
  triggered: boolean;
  removed: EvictedCookie[];
}

/** 一次压力淘汰（域级 + 全局）的汇总报告 */
export interface EvictionReport {
  /** 排序依据（人类可读，界面原样展示） */
  basis: string;
  /** 是否有任意一级触发 */
  triggered: boolean;
  stages: EvictionStage[];
  /** 全部被移除条目（先域级后全局，按实际淘汰顺序） */
  removed: EvictedCookie[];
}

/** 容量设置快照 + 每个可注册域的用量（供界面配置与展示） */
export interface CapacityView {
  globalLimit: number | null;
  domainLimits: Array<{ domain: string; limit: number }>;
  totalCount: number;
  usage: Array<{
    domain: string;
    count: number;
    /** 该域配置的上限；null = 未设置（不限） */
    limit: number | null;
  }>;
}

/** 演算时钟快照（供界面与 API 展示） */
export interface ClockView {
  /** 当前演算时间戳（ms） */
  now: number;
  /** 当前演算时间（可读，本地时区） */
  readable: string;
  /** 服务启动时固定的起始时间戳（ms）；重置罐时时钟回到该时刻 */
  startedAt: number;
  /** 起始时间（可读） */
  startedAtReadable: string;
  /** 相对启动时刻已推进的整秒数 */
  elapsedSeconds: number;
}

/** 场景快照格式标识（防止误传其它 JSON） */
export const SNAPSHOT_FORMAT = 'cookie-jar-lab-snapshot';
/** 场景快照版本号（结构升级时递增；导入仅接受当前版本） */
export const SNAPSHOT_VERSION = 1;

/** 快照中的单条 cookie：即 StoredCookie 的完整原始字段（非展示视图） */
export interface SnapshotCookie extends StoredCookie {}

/**
 * 场景快照：可完整复原演算场景的全部状态。
 * 保存原始 Cookie 条目（含分区键、创建序号、创建/更新/最近访问时间）、
 * 容量规则（全局与每可注册域上限）、演算时钟起点与当前值、下一创建序号。
 */
export interface JarSnapshot {
  /** 固定格式标识 */
  format: typeof SNAPSHOT_FORMAT;
  /** 快照版本号 */
  version: typeof SNAPSHOT_VERSION;
  /** 导出时间戳（真实墙钟 ms；仅元信息，不参与演算） */
  exportedAt: number;
  /** 导出时的可读时间（本地时区；仅元信息） */
  exportedAtReadable: string;
  /** 完整原始 Cookie 条目（按创建序号升序） */
  cookies: SnapshotCookie[];
  /** 下一创建序号（恢复后新条目从此编号继续） */
  nextIndex: number;
  /** 容量规则：全局上限（null = 不限）与每个可注册域上限 */
  capacity: {
    globalLimit: number | null;
    domainLimits: Array<{ domain: string; limit: number }>;
  };
  /** 演算时钟：起点（ms）与当前值（ms）；二者之差为非负整秒 */
  clock: {
    startedAt: number;
    now: number;
  };
}

/** 导入快照的结果（成功后回传完整新状态供界面刷新） */
export interface SnapshotImportResult {
  ok: boolean;
  /** 恢复的条目数（含过期项，过期项原样保留） */
  restoredCount: number;
  /** 恢复的域级容量规则条数 */
  domainLimitCount: number;
  /** 全局容量上限；null = 不限 */
  globalLimit: number | null;
  /** 恢复后的演算时钟视图 */
  clock: ClockView;
  /** 恢复后的容量视图 */
  capacity: CapacityView;
  /** 恢复后的罐展示视图（过期项标灰但保留） */
  jar: CookieView[];
  /** 实际生效的快照 */
  snapshot: JarSnapshot;
}

export interface StoreResult {
  ok: boolean;
  action: StoreAction;
  reason: string;
  /** 被更新时沿用的首次创建序号 */
  inheritedIndex?: number;
  /** 非致命的提示信息（例如明文 http 写入 Secure） */
  notices: string[];
  cookie: CookieView | null;
  jar: CookieView[];
  /** 本次入罐触发的容量压力淘汰报告（无任何上限时为 null） */
  eviction: EvictionReport | null;
}

export interface RequestItem {
  index: number;
  cookie: string;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  sameSite: SameSiteMode;
  sameSiteLabel: string;
  /** 是否独立分区 cookie（CHIPS） */
  partitioned: boolean;
  /** 该条目的分区键；未分区为 null */
  partitionKey: string | null;
  verdict: ItemVerdict;
  /** 发送：命中的匹配点；排除：排除原因 */
  detail: string;
  expired: boolean;
}

/** 写入演算的附加选项 */
export interface StoreOptions {
  /**
   * 屏蔽第三方 Cookie（默认 false）：开启时必须提供有效顶层页面 URL（topUrl），
   * 跨站响应拒绝写入/删除普通 Cookie（Partitioned 分区项不受此限）
   */
  blockThirdParty?: boolean;
  /**
   * 写入来源是否为页面脚本的 document.cookie 赋值（默认 false = 网络 Set-Cookie 响应）。
   * true 时追加脚本约束：拒绝带 HttpOnly 的赋值，并拒绝覆盖/删除同身份未过期的 HttpOnly 项；
   * 拒绝在改动罐之前返回，罐内容、时间戳与容量均不变。
   */
  fromScript?: boolean;
  /** 注入当前时间戳（测试用），缺省取演算时钟（jar.now()） */
  now?: number;
}

/** 发送演算的附加上下文（SameSite 判定所需） */
export interface SendOptions {
  /** 顶层页面 URL（决定 same-site 上下文）；缺省视为与请求 URL 相同，即同站 */
  topUrl?: string;
  /** 请求方法（大小写不敏感），缺省 GET */
  method?: string;
  /** 是否顶层导航，缺省 true */
  topLevelNav?: boolean;
  /**
   * 屏蔽第三方 Cookie（默认 false）：开启时必须提供有效顶层页面 URL，
   * 跨站请求排除普通 Cookie（分区键匹配的 Partitioned 项不受此限）
   */
  blockThirdParty?: boolean;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  requestUrl: string;
  host: string;
  path: string;
  secureRequest: boolean;
  /** 实际采用的顶层页面 URL（缺省时回显请求 URL） */
  topUrl: string;
  /** 规范化后的请求方法（大写） */
  method: string;
  topLevelNav: boolean;
  /** 请求站 / 顶层站（scheme + 可注册域；IP、localhost 按完整主机） */
  requestSite: string;
  topSite: string;
  /** 请求站与顶层站是否同站 */
  sameSiteContext: boolean;
  /** 本次演算是否开启了「屏蔽第三方 Cookie」模式 */
  blockThirdParty: boolean;
  /**
   * 请求分区键（由顶层页面 URL 计算，与顶层站 topSite 相同）：
   * 仅分区键相同的 Partitioned 项可发送。
   */
  partitionKey: string;
  cookieHeader: string;
  sent: RequestItem[];
  excluded: RequestItem[];
}

/** 重定向状态码：301/302/303/307/308（方法改写规则各有不同） */
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 重定向链最多 8 个响应步骤（含末跳 200） */
export const MAX_REDIRECT_CHAIN_STEPS = 8;

/** 重定向链中的一个响应步骤（由调用方预先给定，服务不发起真实请求） */
export interface RedirectChainStepInput {
  /** HTTP 状态码：非末跳必须是 301/302/303/307/308；末跳必须是 200 */
  status: number;
  /** 跳转目标 Location：重定向跳必填（可相对），相对值基于当前请求 URL 解析；末跳必须留空 */
  location?: string;
  /** 该响应携带的 Set-Cookie 列表（按给定顺序逐条写入）；每项必须是字符串 */
  setCookies?: string[];
}

/** POST /api/redirect-chain 入参（结构校验在 server 层，语义校验在罐内预先完成） */
export interface RedirectChainInput {
  /** 起始请求 URL（第 1 跳目标），必须是 http(s) 绝对 URL */
  startUrl: string;
  /** 起始请求方法（缺省 GET；大小写不敏感，内部转大写） */
  method?: string;
  /** 固定顶层页面 URL：每一跳都沿用；开启屏蔽第三方 Cookie 时必填 */
  topUrl?: string;
  /** 是否顶层导航（每一跳沿用，缺省 true） */
  topLevelNav?: boolean;
  /** 屏蔽第三方 Cookie 开关（每一跳沿用，缺省 false） */
  blockThirdParty?: boolean;
  /** 响应步骤列表（1~8 个）：前 N-1 个为重定向，最后一个为 200 终态 */
  steps: RedirectChainStepInput[];
}

/** 单条 Set-Cookie 在链中的写入结果（即 StoreResult 去掉随附全罐快照后的精简视图） */
export interface RedirectStoreItem {
  /** 入参的 Set-Cookie 原文 */
  setCookie: string;
  action: StoreAction;
  reason: string;
  notices: string[];
  /** 被更新时沿用的首次创建序号 */
  inheritedIndex?: number;
  cookie: CookieView | null;
  /** 本次写入触发的容量压力淘汰报告（无上限时为 null） */
  eviction: EvictionReport | null;
}

/** 重定向链中一跳的完整演算记录 */
export interface RedirectChainHop {
  /** 从 1 开始的跳序号 */
  hop: number;
  /** 本跳请求 URL（绝对 http(s)） */
  requestUrl: string;
  /** 本跳实际发送的方法（大写；可能已被前一跳的 301/302/303 改写） */
  method: string;
  /** 方法改写说明（来自上一跳的状态码）；首跳为 null */
  methodNote: string | null;
  /** 本跳生成的请求 Cookie 头演算（同 /api/send 的完整逐项结果） */
  send: SendResult;
  /** 响应状态码 */
  status: number;
  /** 响应 Location 原文（已 trim）；末跳为空串 */
  location: string;
  /** 解析后的下一跳绝对 URL；末跳为 null */
  nextUrl: string | null;
  /** 本响应按顺序逐条写入 Set-Cookie 的结果 */
  stores: RedirectStoreItem[];
  /** 本跳全部 Set-Cookie 处理完成后的罐快照 */
  jarAfter: CookieView[];
}

/** POST /api/redirect-chain 结果：失败时 ok=false 且 hops 为空（罐保持不变） */
export interface RedirectChainResult {
  ok: boolean;
  error?: string;
  startUrl: string;
  /** 规范化后的起始方法（大写） */
  method: string;
  topUrl: string;
  topLevelNav: boolean;
  blockThirdParty: boolean;
  hops: RedirectChainHop[];
}

/** document.cookie 读取演算中的单项（脚本视角） */
export interface ScriptReadItem {
  index: number;
  cookie: string;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** 是否独立分区 cookie（CHIPS） */
  partitioned: boolean;
  /** 该条目的分区键；未分区为 null */
  partitionKey: string | null;
  verdict: ItemVerdict;
  /** 可读：命中的匹配点；不可读：排除原因 */
  detail: string;
  expired: boolean;
}

/** document.cookie 读取演算的附加上下文 */
export interface ScriptReadOptions {
  /** 顶层页面 URL（决定分区键与跨站判定）；开启第三方屏蔽时必填，否则缺省视为与页面 URL 相同 */
  topUrl?: string;
  /**
   * 屏蔽第三方 Cookie（默认 false）：开启时必须提供有效顶层页面 URL，
   * 跨站页面排除普通 Cookie（分区键匹配的 Partitioned 项不受此限）
   */
  blockThirdParty?: boolean;
}

/** document.cookie 读取演算结果 */
export interface ScriptReadResult {
  ok: boolean;
  error?: string;
  /** 页面脚本所在文档的 URL */
  pageUrl: string;
  host: string;
  path: string;
  securePage: boolean;
  /** 实际采用的顶层页面 URL（缺省时回显页面 URL） */
  topUrl: string;
  /** 页面站 / 顶层站（scheme + 可注册域；IP、localhost 按完整主机） */
  pageSite: string;
  topSite: string;
  /** 页面站与顶层站是否同站 */
  sameSiteContext: boolean;
  /** 本次演算是否开启了「屏蔽第三方 Cookie」模式 */
  blockThirdParty: boolean;
  /** 页面分区键（由顶层页面 URL 计算） */
  partitionKey: string;
  /** document.cookie 读到的字符串（可读项按 Path 长度降序 / 创建顺序升序后以 "; " 拼接） */
  cookieString: string;
  readable: ScriptReadItem[];
  excluded: ScriptReadItem[];
}

/** 年份过大会让 Date 抛异常，这里钳制到一个安全的绝对上限（约公元 275760 年） */
const MAX_SAFE_EXPIRES = 8_640_000_000_000_000;

/** 默认 Lax 的跨站顶层 POST 宽限：创建不超过 120 秒（对齐 Chrome 的 Lax+POST 缓解） */
export const LAX_POST_GRACE_MS = 120_000;

/** RFC 7231 安全方法：跨站顶层导航时显式 Lax 允许发送 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** 容量淘汰的优先级权重：越小越先被淘汰 */
const PRIORITY_RANK: Record<CookiePriority, number> = { low: 0, medium: 1, high: 2 };

/** 容量淘汰排序依据（界面展示） */
export const EVICTION_BASIS = '优先级从低到高（Low → Medium → High），同级按最近访问时间从早到晚，再同则按创建序号从小到大';

/** cookie-name 允许的可见 ASCII（RFC 6265 token，排除分隔符与空白） */
const VALID_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地时区的可读时间，例如 2026-09-18 14:03:07 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 剩余有效期的人类可读描述 */
export function formatRemaining(expiresAt: number, now: number): string {
  let ms = expiresAt - now;
  if (ms <= 0) return '已过期';
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0) parts.push(`${mins} 分`);
  parts.push(`${secs} 秒`);
  return parts.join(' ');
}

/**
 * 解析单条 Set-Cookie 头（不含 "Set-Cookie:" 前缀）。
 * 第一个 "=" 之前为 name、其后到第一个 ";" 之前为 value；其余为属性。
 */
export function parseSetCookie(raw: string): ParsedSetCookie {
  const header = raw.trim();
  if (header.length === 0) {
    throw new Error('Set-Cookie 内容为空');
  }

  const segments = header.split(';').map((s) => s.trim());
  const first = segments[0];
  const eq = first.indexOf('=');
  if (eq <= 0) {
    throw new Error('缺少有效的 cookie-name（需要 "名称=值" 形式）');
  }

  const name = first.slice(0, eq).trim();
  let value = first.slice(eq + 1).trim();
  if (name.length === 0 || !VALID_NAME_RE.test(name)) {
    throw new Error(`cookie-name 非法："${name}"`);
  }
  // 值允许为空字符串；去掉成对的双引号（cookie-value 的 quoted-string 形式）
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  const parsed: ParsedSetCookie = {
    name,
    value,
    maxAgeInvalid: false,
    secure: false,
    httpOnly: false,
    sameSite: 'lax',
    sameSiteDefault: true,
    sameSiteInvalid: false,
    priority: 'medium',
    priorityDefault: true,
    priorityInvalid: false,
    partitioned: false,
  };

  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.length === 0) continue;
    const semi = seg.indexOf('=');
    const attrName = (semi === -1 ? seg : seg.slice(0, semi)).trim().toLowerCase();
    const attrValue = semi === -1 ? '' : seg.slice(semi + 1).trim();

    switch (attrName) {
      case 'domain':
        if (attrValue.length > 0) parsed.domain = attrValue;
        break;
      case 'path':
        if (attrValue.length > 0) parsed.path = attrValue;
        break;
      case 'max-age': {
        if (!/^-?\d+$/.test(attrValue)) {
          parsed.maxAgeInvalid = true;
        } else {
          const n = Number(attrValue);
          parsed.maxAge = Number.isFinite(n) ? n : undefined;
          if (!Number.isFinite(n)) parsed.maxAgeInvalid = true;
        }
        break;
      }
      case 'secure':
        parsed.secure = true;
        break;
      case 'httponly':
        parsed.httpOnly = true;
        break;
      case 'samesite': {
        // Strict / Lax / None，大小写不敏感；未声明或非法值一律记为默认 Lax
        const v = attrValue.toLowerCase();
        if (v === 'strict' || v === 'lax' || v === 'none') {
          parsed.sameSite = v;
          parsed.sameSiteDefault = false;
        } else {
          parsed.sameSite = 'lax';
          parsed.sameSiteDefault = true;
          parsed.sameSiteInvalid = true;
        }
        break;
      }
      case 'priority': {
        // Low / Medium / High，大小写不敏感；缺省或非法值一律记为默认 Medium
        const v = attrValue.toLowerCase();
        if (v === 'low' || v === 'medium' || v === 'high') {
          parsed.priority = v;
          parsed.priorityDefault = false;
        } else {
          parsed.priority = 'medium';
          parsed.priorityDefault = true;
          parsed.priorityInvalid = true;
        }
        break;
      }
      case 'partitioned':
        // CHIPS 独立分区 cookie：无值标志属性（属性值若存在也忽略）
        parsed.partitioned = true;
        break;
      // Expires / 未知属性：本演算不参与，直接忽略
      default:
        break;
    }
  }

  return parsed;
}

/** 域规范化：小写并去掉最多一个前导点（RFC 5.3.6） */
export function canonicalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  if (d.startsWith('.')) d = d.slice(1);
  // IPv6/IPvFuture 可能被方括号包裹，去掉外壳
  if (d.startsWith('[') && d.endsWith(']')) d = d.slice(1, -1);
  return d;
}

/** 从绝对 URL 中取出主机（小写、无方括号、无端口）；非法 http(s) URL 返回 null */
export function hostFromUrl(rawUrl: string): { host: string; protocol: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return null;
  }
  if (!u.hostname) return null;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, protocol: u.protocol, path: u.pathname || '/' };
}

/** 粗略识别 IPv4 / IPv6（含 zone id）主机；IP 主机不参与域/子域匹配 */
export function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((p) => Number(p) <= 255);
  }
  // 至少包含一个冒号即按 IPv6 处理（URL 解析后不含方括号；zone id 的 % 也允许）
  return host.includes(':') && /^[0-9a-f:%]+$/i.test(host);
}

/**
 * 计算「站点」（site，schemeful same-site）：scheme + 可注册域（eTLD+1）。
 * 可注册域由 tldts（内置公共后缀列表 PSL，含私有域段）判定；
 * IP 地址、localhost 等无可注册域的主机按完整主机比较。
 */
export function siteOf(host: string, protocol: string): string {
  const domain = isIpAddress(host) ? null : getDomain(host, { allowPrivateDomains: true });
  return `${protocol}//${domain ?? host}`;
}

/**
 * 计算分区 cookie（CHIPS Partitioned）的分区键：顶层站点 site = scheme + 可注册域
 * （eTLD+1；IP、localhost 等无可注册域的主机用完整主机）。
 * 入参为顶层页面 URL；非法或非 http(s) 地址返回 null（此时 Partitioned cookie 拒绝入罐）。
 */
export function partitionKeyFromUrl(rawUrl: string): { key: string; host: string; protocol: string } | null {
  const info = hostFromUrl(rawUrl);
  if (!info) return null;
  return { key: siteOf(info.host, info.protocol), host: info.host, protocol: info.protocol };
}

/**
 * 取「可注册域」（eTLD+1）作为容量统计 / 域级淘汰的分桶键：
 * 由 tldts（PSL，含私有域段）判定；IP、localhost 等无可注册域的主机按完整主机。
 */
export function registrableDomain(host: string): string {
  const domain = isIpAddress(host) ? null : getDomain(host, { allowPrivateDomains: true });
  return domain ?? host;
}

/** SameSite 展示标签：Strict / Lax / Lax（默认）/ None */
export function sameSiteLabel(sameSite: SameSiteMode, sameSiteDefault: boolean): string {
  const base = sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax';
  return sameSiteDefault ? `${base}（默认）` : base;
}

/** Priority 展示标签：Low / Medium（默认）/ High */
export function priorityLabel(priority: CookiePriority, priorityDefault: boolean): string {
  const base = priority === 'low' ? 'Low' : priority === 'high' ? 'High' : 'Medium';
  return priorityDefault ? `${base}（默认）` : base;
}

/** Partitioned 展示标签：未分区 / 分区 <key> */
export function partitionLabel(partitioned: boolean, partitionKey: string | null): string {
  return partitioned ? `分区 ${partitionKey ?? ''}` : '未分区';
}

/**
 * domain-match（RFC 5.1.3）：
 *  host-only cookie 要求 host 与 domain 完全相等；
 *  Domain cookie 要求 host == domain，或 host 以 "." + domain 结尾。
 */
export function domainMatch(host: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  if (host === cookie.domain) return true;
  return host.endsWith(`.${cookie.domain}`);
}

/**
 * default-path（RFC 5.1.4）：
 *  - 路径为空或不以 "/" 开头：默认 "/"
 *  - 只有一个斜杠：默认 "/"
 *  - 否则取最后一个斜杠之前的部分（不含最后斜杠后的任何字符）
 */
export function defaultPath(requestPath: string): string {
  const p = requestPath || '/';
  if (!p.startsWith('/')) return '/';
  const lastSlash = p.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return p.slice(0, lastSlash);
}

/**
 * path-match（RFC 5.1.4）：
 *  - request-path 与 cookie-path 相等；或
 *  - request-path 以 cookie-path 开头，且 cookie-path 以 "/" 结尾；或
 *  - request-path 以 cookie-path 开头，且紧随其后的字符是 "/"
 */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath.charAt(cookiePath.length) === '/';
}

/** 内存 Cookie 罐 */
export class CookieJar {
  private cookies: StoredCookie[] = [];
  private nextIndex = 1;
  /** 全局容量上限（条目数）；null = 不限 */
  private globalLimit: number | null = null;
  /** 每个可注册域的容量上限；未列出表示不限 */
  private domainLimits = new Map<string, number>();
  /** 演算时钟起点：服务启动时固定的真实时间（重置罐时时钟回到该时刻；导入快照时随快照恢复） */
  private clockStart: number = Date.now();
  /** 演算时钟当前值（ms）：不随真实时间流动，只能经 advance() 以正整数秒推进 */
  private clockNow: number = this.clockStart;

  /** 当前演算时间戳（ms）：网络读写、脚本读写、罐快照与容量淘汰统一取它 */
  now(): number {
    return this.clockNow;
  }

  /** 演算时钟快照（界面与 API 展示用） */
  clock(): ClockView {
    return {
      now: this.clockNow,
      readable: formatTime(this.clockNow),
      startedAt: this.clockStart,
      startedAtReadable: formatTime(this.clockStart),
      elapsedSeconds: Math.floor((this.clockNow - this.clockStart) / 1000),
    };
  }

  /**
   * 推进演算时钟：仅接受正整数秒；非法输入（0、负数、非整数、非有限数）抛错，
   * 时间与罐均不变。推进本身不删除任何条目——过期项留在罐中，
   * 下次匹配（发送/脚本读取）或容量淘汰时再按既有规则处理。
   */
  advance(seconds: number): ClockView {
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1) {
      throw new Error(`推进秒数必须是不小于 1 的正整数（收到：${String(seconds)}），时钟与罐均未改动`);
    }
    this.clockNow = Math.min(this.clockNow + seconds * 1000, MAX_SAFE_EXPIRES);
    return this.clock();
  }

  /**
   * 按顺序处理一次「响应 URL + 单条 Set-Cookie」写入。
   * topUrl 为顶层页面 URL：仅在 Set-Cookie 带 Partitioned 时使用（计算分区键）；
   * 普通 cookie 忽略它——除非 options.blockThirdParty 开启（屏蔽第三方 Cookie），
   * 此时 topUrl 必填且须为有效 http(s) 地址：跨站响应的普通 cookie 拒绝写入/删除
   * （不改动罐、不触发容量淘汰），Partitioned 分区项仍按既有规则处理。
   * 返回动作（入罐 / 更新 / 删除 / 拒绝）及原因。
   */
  store(responseUrl: string, setCookieHeader: string, topUrl?: string, options: StoreOptions = {}): StoreResult {
    const now = options.now ?? this.clockNow;
    const urlInfo = hostFromUrl(responseUrl);
    if (!urlInfo) {
      return this.result(false, 'rejected', `响应 URL 非法或非 http(s)：${responseUrl}`, []);
    }

    let parsed: ParsedSetCookie;
    try {
      parsed = parseSetCookie(setCookieHeader);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.result(false, 'rejected', `Set-Cookie 解析失败：${message}`, []);
    }

    const { host } = urlInfo;
    const notices: string[] = [];

    // ---- 0a. document.cookie 脚本赋值：HttpOnly 只能由网络 Set-Cookie 设置，脚本无权声明 ----
    // 拒绝发生在任何罐改动之前：罐内容、时间戳与容量均不变。
    const fromScript = options.fromScript === true;
    if (fromScript && parsed.httpOnly) {
      return this.result(
        false,
        'rejected',
        'document.cookie 脚本赋值不能设置 HttpOnly 属性（HttpOnly cookie 只能由网络响应的 Set-Cookie 写入），拒绝本次赋值；罐内容、时间戳与容量均未改动',
        notices,
        parsed,
      );
    }

    // ---- 0b. document.cookie 脚本赋值：禁止覆盖/删除同身份未过期的 HttpOnly 项 ----
    // 存储身份 = (name, domain, path, 分区键)：需要先按既有规则算出 domain/path/分区键。
    // 已过期的 HttpOnly 项不在保护之列（脚本赋值可正常顶替）。
    if (fromScript) {
      const protectedCookie = this.findHttpOnlyForScript(parsed, urlInfo, topUrl, now);
      if (protectedCookie) {
        const isDelete = parsed.maxAge !== undefined && parsed.maxAge <= 0;
        const op = isDelete ? '删除' : '覆盖';
        const verdict = isDelete
          ? `拒绝以 Max-Age=${parsed.maxAge}（≤0）删除该 HttpOnly 项（HttpOnly cookie 的删除只能由网络 Set-Cookie 发起）`
          : `拒绝以 document.cookie 赋值覆盖该 HttpOnly 项（HttpOnly cookie 对页面脚本不可见，不能被脚本改写）`;
        return this.result(
          false,
          'rejected',
          `document.cookie 脚本赋值与罐中同身份（name、domain、path、分区键均相同）且未过期的 HttpOnly 项 ` +
            `${parsed.name}=…（#${protectedCookie.creationIndex}，domain=${protectedCookie.domain}，path=${protectedCookie.path}，` +
            `${partitionLabel(protectedCookie.partitioned, protectedCookie.partitionKey)}）冲突，${op}被拒绝：${verdict}；` +
            `罐内容、时间戳与容量均未改动（已过期的 HttpOnly 项不在保护之列，网络接口仍可正常 ${op}）`,
          notices,
          parsed,
        );
      }
    }

    // ---- 0. 屏蔽第三方 Cookie（可选模式）：跨站响应的普通 cookie 拒绝写入/删除 ----
    // 判定用既有「站点」规则：scheme + 可注册域（IP、localhost 按完整主机）。
    // 拒绝直接返回，不触碰罐内容，也不会触发容量淘汰。
    const blockThirdParty = options.blockThirdParty === true;
    if (blockThirdParty) {
      const topRaw = typeof topUrl === 'string' ? topUrl.trim() : '';
      const topInfo = topRaw === '' ? null : hostFromUrl(topRaw);
      if (topInfo === null) {
        return this.result(
          false,
          'rejected',
          '已开启屏蔽第三方 Cookie：必须提供有效的顶层页面 URL（http(s)）作为跨站判定基准' +
            (topRaw === '' ? '，当前未填写，拒绝入罐' : `，当前值非法或非 http(s)：${topRaw}，拒绝入罐`),
          notices,
          parsed,
        );
      }
      const responseSite = siteOf(host, urlInfo.protocol);
      const topSite = siteOf(topInfo.host, topInfo.protocol);
      if (responseSite !== topSite && !parsed.partitioned) {
        const op = parsed.maxAge !== undefined && parsed.maxAge <= 0 ? '删除' : '写入';
        return this.result(
          false,
          'rejected',
          `已开启屏蔽第三方 Cookie：跨站响应（响应站 ${responseSite} ≠ 顶层站 ${topSite}）` +
            `拒绝${op}普通 Cookie（罐内容未改动，不触发容量淘汰）；` +
            `带 Partitioned 的分区 cookie 不受此限，仍按 Secure 与分区键规则处理`,
          notices,
          parsed,
        );
      }
    }

    // ---- 1. Domain 处理：规范化 + 与响应主机校验 ----
    let domain: string;
    let hostOnly: boolean;
    if (parsed.domain === undefined) {
      // 省略 Domain：host-only，域就是原主机
      domain = host;
      hostOnly = true;
    } else {
      domain = canonicalizeDomain(parsed.domain);
      if (domain.length === 0) {
        return this.result(false, 'rejected', 'Domain 属性为空，无法入罐', notices, parsed);
      }
      if (isIpAddress(host) || isIpAddress(domain)) {
        // RFC 6265：IP 主机忽略 Domain 属性，按 host-only 处理
        if (host !== domain) {
          return this.result(
            false,
            'rejected',
            `响应主机 ${host} 是 IP 地址，Domain=${domain} 与其不一致；IP 不允许域/子域匹配，拒绝入罐`,
            notices,
            parsed,
          );
        }
        domain = host;
        hostOnly = true;
        notices.push(`主机为 IP 地址，忽略 Domain 属性，按 host-only 记录`);
      } else if (host === domain) {
        hostOnly = false;
      } else if (host.endsWith(`.${domain}`)) {
        hostOnly = false;
      } else {
        return this.result(
          false,
          'rejected',
          `Domain=${domain} 不匹配响应主机 ${host}（既不是主机本身，也不是其上级域），拒绝入罐`,
          notices,
          parsed,
        );
      }
    }

    // ---- 2. Path 处理：缺省取 default-path ----
    let cookiePath: string;
    if (parsed.path === undefined || !parsed.path.startsWith('/')) {
      cookiePath = defaultPath(urlInfo.path);
      if (parsed.path !== undefined) {
        notices.push(`Path="${parsed.path}" 不是绝对路径，忽略并使用默认 Path=${cookiePath}`);
      } else {
        notices.push(`Path 属性缺省，取默认路径（响应 URL 最后一个斜杠前的目录）：${cookiePath}`);
      }
    } else {
      cookiePath = parsed.path;
    }

    // ---- 3. Secure 提示：明文 http 响应写入 Secure ----
    if (parsed.secure && urlInfo.protocol === 'http:') {
      notices.push('响应来自明文 http:// 却带 Secure 属性：真实浏览器通常会拒绝该 cookie；本罐仍记录，但它永远不会经 http 请求发送');
    }
    if (parsed.maxAgeInvalid) {
      notices.push('Max-Age 值非法（非整数），已忽略该属性，按会话 cookie 处理（Expires 同样不参与本演算）');
    }

    // ---- 3.5 SameSite=None 必须带 Secure，否则拒绝入罐 ----
    if (parsed.sameSite === 'none' && !parsed.secure) {
      return this.result(
        false,
        'rejected',
        'SameSite=None 必须同时声明 Secure（现代浏览器强制要求，防止明文传输跨站 cookie），拒绝入罐',
        notices,
        parsed,
      );
    }
    if (parsed.sameSiteInvalid) {
      notices.push('SameSite 值非法（仅识别 Strict / Lax / None，大小写不敏感），已按默认 Lax 处理');
    }
    if (parsed.priorityInvalid) {
      notices.push('Priority 值非法（仅识别 Low / Medium / High，大小写不敏感），已按默认 Medium 处理');
    } else if (parsed.priorityDefault) {
      notices.push('Priority 属性缺省，已按默认 Medium 参与容量淘汰');
    }

    // ---- 3.6 Partitioned（CHIPS）：必须同时带 Secure，且顶层页面 URL 为有效 http(s) 地址 ----
    let partitionKey: string | null = null;
    if (parsed.partitioned) {
      if (!parsed.secure) {
        return this.result(
          false,
          'rejected',
          'Partitioned cookie 必须同时声明 Secure（CHIPS 仅允许独立分区的安全 cookie），拒绝入罐',
          notices,
          parsed,
        );
      }
      const topRaw = typeof topUrl === 'string' ? topUrl.trim() : '';
      if (topRaw === '') {
        return this.result(
          false,
          'rejected',
          '带 Partitioned 属性的 Set-Cookie 需要提供有效的顶层页面 URL（写入页的 topUrl 字段）作为分区键来源，拒绝入罐',
          notices,
          parsed,
        );
      }
      const partition = partitionKeyFromUrl(topRaw);
      if (!partition) {
        return this.result(
          false,
          'rejected',
          `Partitioned 的顶层页面 URL 非法或非 http(s)：${topRaw}（分区键需由有效 http(s) 地址计算），拒绝入罐`,
          notices,
          parsed,
        );
      }
      partitionKey = partition.key;
      notices.push(`Partitioned 独立分区 cookie：分区键取顶层页面 ${topRaw} 的 scheme + 可注册域 = ${partitionKey}`);
    }

    const existing = this.findCookie(parsed.name, domain, cookiePath, partitionKey);

    // ---- 4. Max-Age <= 0：删除同名 (name, domain, path[, 分区]) 项 ----
    if (parsed.maxAge !== undefined && parsed.maxAge <= 0) {
      const partitionText = partitionKey === null ? '未分区' : `分区 ${partitionKey}`;
      if (existing) {
        this.cookies = this.cookies.filter((c) => c !== existing);
        return this.result(
          true,
          'deleted',
          `Max-Age=${parsed.maxAge}（≤0），已删除同名同域同路径项 ${parsed.name}=…（#${existing.creationIndex}，domain=${domain}，path=${cookiePath}，${partitionText}）`,
          notices,
        );
      }
      return this.result(
        true,
        'deleted',
        `Max-Age=${parsed.maxAge}（≤0）要求删除 ${parsed.name}，但罐中不存在 domain=${domain}、path=${cookiePath}、${partitionText} 的同名项，无可删除（不影响其他分区或普通项）`,
        notices,
      );
    }

    // ---- 5. 计算过期时间（合法的正 Max-Age）----
    let expiresAt: number | undefined;
    if (parsed.maxAge !== undefined && parsed.maxAge > 0) {
      expiresAt = Math.min(now + parsed.maxAge * 1000, MAX_SAFE_EXPIRES);
    }

    // ---- 6. 入罐或更新（同名同域同路径[+分区]覆盖，沿用首次创建序号）----
    if (existing) {
      existing.value = parsed.value;
      existing.hostOnly = hostOnly;
      existing.secure = parsed.secure;
      existing.httpOnly = parsed.httpOnly;
      existing.sameSite = parsed.sameSite;
      existing.sameSiteDefault = parsed.sameSiteDefault;
      existing.priority = parsed.priority;
      existing.priorityDefault = parsed.priorityDefault;
      // partitioned / partitionKey 是存储身份的一部分，命中的 existing 必然相同
      existing.partitioned = parsed.partitioned;
      existing.partitionKey = partitionKey;
      existing.expiresAt = expiresAt;
      existing.updatedAt = now;
      // 覆盖更新视为一次访问（RFC 6265bis creation/access-time 语义）
      existing.lastAccessedAt = now;

      // ---- 7. 容量压力：依次执行域级、全局淘汰 ----
      const eviction = this.enforceAfterStore(existing, now);
      this.appendEvictionNotices(notices, eviction);

      return {
        ok: true,
        action: 'updated',
        reason: `同名同域同路径${parsed.partitioned ? '同分区' : ''}的 ${parsed.name} 已存在（#${existing.creationIndex}，${partitionLabel(parsed.partitioned, partitionKey)}），覆盖更新（value/属性以新 Set-Cookie 为准，创建顺序沿用）；Priority=${priorityLabel(parsed.priority, parsed.priorityDefault)}`,
        inheritedIndex: existing.creationIndex,
        notices,
        cookie: this.toView(existing, now),
        jar: this.views(now),
        eviction,
      };
    }

    const stored: StoredCookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      path: cookiePath,
      hostOnly,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
      sameSiteDefault: parsed.sameSiteDefault,
      priority: parsed.priority,
      priorityDefault: parsed.priorityDefault,
      partitioned: parsed.partitioned,
      partitionKey,
      expiresAt,
      creationIndex: this.nextIndex,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
    };
    this.nextIndex += 1;
    this.cookies.push(stored);

    // ---- 7. 容量压力：依次执行域级、全局淘汰 ----
    const eviction = this.enforceAfterStore(stored, now);
    this.appendEvictionNotices(notices, eviction);
    const survived = !eviction || !eviction.removed.some((r) => r.index === stored.creationIndex);

    const scopeText = hostOnly
      ? `host-only：仅向主机 ${domain} 发送`
      : `domain：向 ${domain} 及其所有子域（例如 a.${domain}）发送`;
    const lifeText =
      expiresAt === undefined
        ? '会话 cookie（本工具中不过期，重置即清空）'
        : `Max-Age=${parsed.maxAge}s，将于 ${formatTime(expiresAt)} 过期`;
    const sameSiteText = `SameSite=${sameSiteLabel(parsed.sameSite, parsed.sameSiteDefault)}`;
    const priorityText = `Priority=${priorityLabel(parsed.priority, parsed.priorityDefault)}`;
    const partitionText = parsed.partitioned
      ? `Partitioned（分区键 ${partitionKey}，仅在该顶层分区内发送）；`
      : '';
    return this.result(
      true,
      'stored',
      `已入罐：${parsed.name}=${parsed.value}；${scopeText}；Path=${cookiePath}；${partitionText}${sameSiteText}；${priorityText}；${lifeText}` +
        (survived ? '' : '（随后即因容量压力被淘汰，详见淘汰清单）'),
      notices,
      parsed,
      survived ? stored : undefined,
      eviction,
      now,
    );
  }

  /**
   * 对请求演算 Cookie 头。
   * 除请求 URL 外还需 SameSite / 分区上下文：顶层页面 URL、请求方法、是否顶层导航
   * （缺省：顶层页 = 请求 URL、GET、顶层导航，即同站安全方法，全部 SameSite 模式放行）。
   * 请求分区键由顶层页面 URL（缺省取请求 URL）计算；Partitioned 项仅在分区键相同时发送。
   * 逐项给出 send / exclude 及原因；发送项按 Path 长度降序、首次创建顺序升序排列。
   */
  send(requestUrl: string, options: SendOptions = {}, now: number = this.clockNow): SendResult {
    const urlInfo = hostFromUrl(requestUrl);
    if (!urlInfo) {
      return this.sendError(`请求 URL 非法或非 http(s)：${requestUrl}`, requestUrl);
    }

    const blockThirdParty = options.blockThirdParty === true;

    // 顶层页面 URL：缺省视为与请求 URL 相同（同站上下文）；
    // 但开启屏蔽第三方 Cookie 时必须显式提供有效的顶层页面 URL 作为跨站判定基准
    const topRaw = typeof options.topUrl === 'string' ? options.topUrl.trim() : '';
    if (blockThirdParty && topRaw === '') {
      return this.sendError(
        '已开启屏蔽第三方 Cookie：必须提供有效的顶层页面 URL（http(s)）作为跨站判定基准，当前未填写',
        requestUrl,
        true,
      );
    }
    let topInfo = urlInfo;
    let topUrl = requestUrl;
    if (topRaw !== '') {
      const parsedTop = hostFromUrl(topRaw);
      if (!parsedTop) {
        return this.sendError(`顶层页面 URL 非法或非 http(s)：${topRaw}`, requestUrl, blockThirdParty);
      }
      topInfo = parsedTop;
      topUrl = topRaw;
    }

    const method = (options.method ?? 'GET').trim().toUpperCase() || 'GET';
    const topLevelNav = options.topLevelNav ?? true;

    const { host, protocol, path } = urlInfo;
    const secureRequest = protocol === 'https:';

    // same-site = scheme + 可注册域（IP / localhost 按完整主机）
    const requestSite = siteOf(host, protocol);
    const topSite = siteOf(topInfo.host, topInfo.protocol);
    const sameSiteContext = requestSite === topSite;
    // 请求分区键 = 顶层站点（CHIPS 分区 cookie 仅在键相同的分区发送）
    const partitionKey = topSite;
    const safeMethod = SAFE_METHODS.has(method);
    const siteCompare = `请求站 ${requestSite} ${sameSiteContext ? '=' : '≠'} 顶层站 ${topSite}`;

    const sent: RequestItem[] = [];
    const excluded: RequestItem[] = [];

    for (const c of this.cookies) {
      const expired = c.expiresAt !== undefined && c.expiresAt <= now;
      const label = sameSiteLabel(c.sameSite, c.sameSiteDefault);
      const base: RequestItem = {
        index: c.creationIndex,
        cookie: `${c.name}=${c.value}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        hostOnly: c.hostOnly,
        path: c.path,
        secure: c.secure,
        sameSite: c.sameSite,
        sameSiteLabel: label,
        partitioned: c.partitioned,
        partitionKey: c.partitionKey,
        verdict: 'exclude',
        detail: '',
        expired,
      };

      // 按 RFC 6265 的顺序逐项检查
      if (expired) {
        base.detail = `已过期（${formatTime(c.expiresAt as number)}），不发送`;
        excluded.push(base);
        continue;
      }
      // 分区隔离（CHIPS）：分区项只在键相同的请求分区发送；键不同直接排除
      if (c.partitioned && c.partitionKey !== partitionKey) {
        base.detail =
          `Partitioned 分区 cookie 仅在其分区内发送：条目分区键 ${c.partitionKey} ≠ 请求分区键 ${partitionKey}` +
          `（由顶层页面 ${topUrl} 计算），跨分区不发送`;
        excluded.push(base);
        continue;
      }
      // 屏蔽第三方 Cookie（可选模式）：跨站请求排除普通 cookie；
      // 分区键匹配的 Partitioned 项豁免，继续走后续既有检查。
      // 被排除的条目不刷新最近访问时间（只有发送成功才刷新）。
      if (blockThirdParty && !sameSiteContext && !c.partitioned) {
        base.detail =
          `已开启屏蔽第三方 Cookie：跨站请求（${siteCompare}）排除普通 Cookie，不发送；` +
          `分区键匹配的 Partitioned 项不受此限`;
        excluded.push(base);
        continue;
      }
      if (!domainMatch(host, c)) {
        base.detail = c.hostOnly
          ? `host-only cookie 仅匹配原主机 ${c.domain}，请求主机 ${host} 不相等`
          : `Domain cookie 匹配域 ${c.domain} 及其子域，请求主机 ${host} 不属于该范围`;
        excluded.push(base);
        continue;
      }
      if (!pathMatch(path, c.path)) {
        base.detail = `Path 不匹配：cookie-path="${c.path}"，request-path="${path}"（需相等，或以其开头且边界为 "/"）`;
        excluded.push(base);
        continue;
      }
      if (c.secure && !secureRequest) {
        base.detail = `Secure cookie 仅经 https 发送，请求为明文 ${protocol}//`;
        excluded.push(base);
        continue;
      }

      // ---- SameSite 站点演算 ----
      const ssVerdict = this.sameSiteVerdict(c, label, {
        sameSiteContext,
        siteCompare,
        topLevelNav,
        safeMethod,
        method,
        now,
      });
      if (ssVerdict.excludeReason !== null) {
        base.detail = ssVerdict.excludeReason;
        excluded.push(base);
        continue;
      }

      base.verdict = 'send';
      const hostWay = c.hostOnly ? '主机精确相等' : `主机 ${host} 命中域 ${c.domain}`;
      const partitionWay = c.partitioned ? `；分区键 ${partitionKey} 匹配（Partitioned）` : '';
      const thirdPartyWay =
        blockThirdParty && !sameSiteContext && c.partitioned
          ? '；屏蔽第三方 Cookie 已开启：跨站普通 Cookie 被排除，分区键匹配的 Partitioned 项豁免'
          : '';
      base.detail = `匹配通过：${hostWay}；request-path "${path}" 命中 cookie-path "${c.path}"` +
        (c.secure ? '；https 满足 Secure' : '') +
        partitionWay +
        thirdPartyWay +
        `；${ssVerdict.note}`;
      // 发送成功即「访问」：刷新最近访问时间（容量淘汰 LRA 依据）
      c.lastAccessedAt = now;
      sent.push(base);
    }

    // 排序：Path 长度降序；相等时首次创建顺序升序
    sent.sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length;
      return a.index - b.index;
    });

    const cookieHeader = sent.map((i) => i.cookie).join('; ');

    // 排除列表保持创建顺序，便于对照
    excluded.sort((a, b) => a.index - b.index);

    return {
      ok: true,
      requestUrl,
      host,
      path,
      secureRequest,
      topUrl,
      method,
      topLevelNav,
      requestSite,
      topSite,
      sameSiteContext,
      blockThirdParty,
      partitionKey,
      cookieHeader,
      sent,
      excluded,
    };
  }

  /**
   * 重定向链演算（POST /api/redirect-chain）：
   * 按调用方给定的起始 URL、方法、固定顶层页面 URL（与顶层导航 / 第三方屏蔽开关）
   * 及最多 8 个响应步骤（状态码、Location、Set-Cookie 列表）逐跳演算。
   *
   * 每一跳：先用现有 send() 规则按当前 URL/方法生成 Cookie 请求头，
   * 再按给定顺序把该响应的 Set-Cookie 逐条写入（响应 URL = 当前请求 URL）。
   *
   * 方法改写：303 之后一律改 GET（但 HEAD 保留为 HEAD）；301/302 仅把 POST 改 GET；
   * 307/308 保留方法。顶层页面 URL、顶层导航与第三方屏蔽开关整条链固定沿用。
   * 相对 Location 基于当前请求 URL 解析（new URL(location, current)），
   * 解析结果仍必须是 http(s)（mailto:/javascript: 等拒绝）。
   *
   * 先对整条链做完整预校验（起始/顶层 URL、每跳目标 URL、状态码与 Location 组合、
   * Set-Cookie 列表类型）；任一不通过立即返回 ok=false，且不做任何 send 刷新或写入——
   * 罐保持不变。校验通过后才逐跳执行（send/store 本身不会再失败）。
   */
  runRedirectChain(input: RedirectChainInput): RedirectChainResult {
    const fail = (error: string): RedirectChainResult => ({
      ok: false,
      error,
      startUrl: '',
      method: '',
      topUrl: '',
      topLevelNav: false,
      blockThirdParty: false,
      hops: [],
    });

    const startUrl = input.startUrl.trim();
    if (hostFromUrl(startUrl) === null) {
      return fail(`重定向链预校验失败：起始 URL 非法或非 http(s)：${input.startUrl}；罐保持不变`);
    }
    const method = (input.method ?? 'GET').trim().toUpperCase() || 'GET';
    const topRaw = typeof input.topUrl === 'string' ? input.topUrl.trim() : '';
    const blockThirdParty = input.blockThirdParty === true;
    if (topRaw === '' || hostFromUrl(topRaw) === null) {
      return fail(
        '重定向链预校验失败：必须提供有效的固定顶层页面 URL（http(s)），每一跳都沿用它作为 SameSite/' +
          `分区键${blockThirdParty ? ' 与第三方屏蔽' : ''}基准；当前${topRaw === '' ? '未填写' : `值非法或非 http(s)：${topRaw}`}；罐保持不变`,
      );
    }
    const topLevelNav = input.topLevelNav ?? true;
    const steps = input.steps;

    // ---- 预校验：步骤结构 / 状态码与 Location 组合 / 逐跳 URL 解析（不触碰罐）----
    const resolvedUrls: string[] = [startUrl];
    let currentUrl = startUrl;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const isLast = i === steps.length - 1;
      const status = step.status;
      const location = typeof step.location === 'string' ? step.location.trim() : '';

      if (isLast) {
        if (status !== 200) {
          return fail(`重定向链预校验失败：末跳（第 ${i + 1} 步）必须是 200 且无需 Location，当前状态码为 ${status}；罐保持不变`);
        }
        if (location !== '') {
          return fail(`重定向链预校验失败：末跳（第 ${i + 1} 步）为 200，不能携带 Location（收到：${location}）；罐保持不变`);
        }
      } else {
        if (!REDIRECT_STATUSES.has(status)) {
          return fail(
            `重定向链预校验失败：第 ${i + 1} 步（非末跳）状态码必须是 301/302/303/307/308 之一，` +
            `当前为 ${status}；罐保持不变`,
          );
        }
        if (location === '') {
          return fail(`重定向链预校验失败：第 ${i + 1} 步为 ${status} 跳转，必须提供 Location；罐保持不变`);
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return fail(`重定向链预校验失败：第 ${i + 1} 步的 Location 无法基于当前 URL 解析：Location="${location}"，当前 URL="${currentUrl}"；罐保持不变`);
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return fail(
            `重定向链预校验失败：第 ${i + 1} 步 Location 解析后的目标必须是 http(s)，` +
            `当前解析为 ${next.href}（协议 ${next.protocol}）；罐保持不变`,
          );
        }
        if (!next.hostname) {
          return fail(`重定向链预校验失败：第 ${i + 1} 步 Location 解析后的目标缺少主机：${next.href}；罐保持不变`);
        }
        currentUrl = next.href;
        resolvedUrls.push(currentUrl);
      }
      const setCookies = step.setCookies;
      if (setCookies !== undefined) {
        if (!Array.isArray(setCookies) || setCookies.some((c) => typeof c !== 'string')) {
          return fail(`重定向链预校验失败：第 ${i + 1} 步的 Set-Cookie 列表必须是字符串数组（可省略或为空）；罐保持不变`);
        }
      }
    }

    // ---- 预校验通过：逐跳执行（先 send 生成头，再按顺序写入 Set-Cookie）----
    const hops: RedirectChainHop[] = [];
    let currentMethod = method;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const requestUrl = resolvedUrls[i];
      const prevStatus = i === 0 ? null : steps[i - 1].status;
      const prevMethod = i === 0 ? null : hops[i - 1].method;
      let methodNote: string | null = null;
      if (prevStatus !== null && prevMethod !== null) {
        if (prevStatus === 303) {
          methodNote =
            prevMethod === 'HEAD'
              ? '上一跳为 303 See Other：后续方法按 GET 改写，但 HEAD 请求保留为 HEAD（本跳仍为 HEAD）'
              : `上一跳为 303 See Other：方法 ${prevMethod} 一律改写为 GET（HEAD 除外，HEAD 保留）`;
        } else if (prevStatus === 301 || prevStatus === 302) {
          methodNote =
            prevMethod === 'POST' && currentMethod === 'GET'
              ? `上一跳为 ${prevStatus}：POST 被改写为 GET（历史表单回退语义；307/308 才严格保留方法）`
              : `上一跳为 ${prevStatus}：仅 POST 改写为 GET，上跳方法 ${prevMethod} 保持不变`;
        } else {
          methodNote = `上一跳为 ${prevStatus}：严格保留请求方法与请求体语义，本跳仍为 ${currentMethod}`;
        }
      }

      const sendResult = this.send(requestUrl, {
        topUrl: topRaw,
        method: currentMethod,
        topLevelNav,
        blockThirdParty,
      });

      const location = typeof step.location === 'string' ? step.location.trim() : '';
      const rawSetCookies = step.setCookies ?? [];
      const stores: RedirectStoreItem[] = rawSetCookies.map((setCookie) => {
        const r = this.store(requestUrl, setCookie, topRaw, { blockThirdParty });
        const item: RedirectStoreItem = {
          setCookie,
          action: r.action,
          reason: r.reason,
          notices: r.notices,
          cookie: r.cookie,
          eviction: r.eviction,
        };
        if (r.inheritedIndex !== undefined) item.inheritedIndex = r.inheritedIndex;
        return item;
      });

      hops.push({
        hop: i + 1,
        requestUrl,
        method: currentMethod,
        methodNote,
        send: sendResult,
        status: step.status,
        location,
        nextUrl: i === steps.length - 1 ? null : resolvedUrls[i + 1],
        stores,
        jarAfter: this.list(),
      });

      // ---- 为下一跳改写方法（末跳无下一跳，无需计算）----
      if (i < steps.length - 1) {
        if (step.status === 303) {
          if (currentMethod !== 'HEAD') currentMethod = 'GET';
        } else if ((step.status === 301 || step.status === 302) && currentMethod === 'POST') {
          currentMethod = 'GET';
        }
        // 307/308：保留方法
      }
    }

    return {
      ok: true,
      startUrl,
      method,
      topUrl: topRaw,
      topLevelNav,
      blockThirdParty,
      hops,
    };
  }

  /**
   * document.cookie 读取演算（页面 JS 视角）：入参为页面 URL、顶层页面 URL 与第三方屏蔽开关。
   * 按既有「过期 → 分区 → 第三方屏蔽 → Domain → Path → Secure」顺序筛选，最后再排除 HttpOnly；
   * 不应用 SameSite（同站脚本文档内读取不受 SameSite 限制），也不刷新任何条目的最近访问时间
   * （纯只读，罐内容不变）。可读项沿用请求头排序（Path 长度降序、创建序号升序），
   * 并以 "; " 拼成 document.cookie 读取字符串；排除项逐项给出原因。
   */
  readDocumentCookie(pageUrl: string, options: ScriptReadOptions = {}): ScriptReadResult {
    const urlInfo = hostFromUrl(pageUrl);
    if (!urlInfo) {
      return this.scriptReadError(`页面 URL 非法或非 http(s)：${pageUrl}`, pageUrl);
    }

    const blockThirdParty = options.blockThirdParty === true;

    const topRaw = typeof options.topUrl === 'string' ? options.topUrl.trim() : '';
    if (blockThirdParty && topRaw === '') {
      return this.scriptReadError(
        '已开启屏蔽第三方 Cookie：必须提供有效的顶层页面 URL（http(s)）作为跨站判定基准，当前未填写',
        pageUrl,
        true,
      );
    }
    let topInfo = urlInfo;
    let topUrl = pageUrl;
    if (topRaw !== '') {
      const parsedTop = hostFromUrl(topRaw);
      if (!parsedTop) {
        return this.scriptReadError(`顶层页面 URL 非法或非 http(s)：${topRaw}`, pageUrl, blockThirdParty);
      }
      topInfo = parsedTop;
      topUrl = topRaw;
    }

    const { host, protocol, path } = urlInfo;
    const securePage = protocol === 'https:';

    const pageSite = siteOf(host, protocol);
    const topSite = siteOf(topInfo.host, topInfo.protocol);
    const sameSiteContext = pageSite === topSite;
    const partitionKey = topSite;
    const siteCompare = `页面站 ${pageSite} ${sameSiteContext ? '=' : '≠'} 顶层站 ${topSite}`;
    const now = this.clockNow;

    const readable: ScriptReadItem[] = [];
    const excluded: ScriptReadItem[] = [];

    for (const c of this.cookies) {
      const expired = c.expiresAt !== undefined && c.expiresAt <= now;
      const base: ScriptReadItem = {
        index: c.creationIndex,
        cookie: `${c.name}=${c.value}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        hostOnly: c.hostOnly,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        partitioned: c.partitioned,
        partitionKey: c.partitionKey,
        verdict: 'exclude',
        detail: '',
        expired,
      };

      // 与网络请求头一致的既有筛选顺序
      if (expired) {
        base.detail = `已过期（${formatTime(c.expiresAt as number)}），document.cookie 读不到`;
        excluded.push(base);
        continue;
      }
      if (c.partitioned && c.partitionKey !== partitionKey) {
        base.detail =
          `Partitioned 分区 cookie 仅在其分区内可读：条目分区键 ${c.partitionKey} ≠ 页面分区键 ${partitionKey}` +
          `（由顶层页面 ${topUrl} 计算），跨分区 document.cookie 读不到`;
        excluded.push(base);
        continue;
      }
      if (blockThirdParty && !sameSiteContext && !c.partitioned) {
        base.detail =
          `已开启屏蔽第三方 Cookie：跨站页面（${siteCompare}）排除普通 Cookie，document.cookie 读不到；` +
          `分区键匹配的 Partitioned 项不受此限`;
        excluded.push(base);
        continue;
      }
      if (!domainMatch(host, c)) {
        base.detail = c.hostOnly
          ? `host-only cookie 仅匹配原主机 ${c.domain}，页面主机 ${host} 不相等`
          : `Domain cookie 匹配域 ${c.domain} 及其子域，页面主机 ${host} 不属于该范围`;
        excluded.push(base);
        continue;
      }
      if (!pathMatch(path, c.path)) {
        base.detail = `Path 不匹配：cookie-path="${c.path}"，页面路径="${path}"（需相等，或以其开头且边界为 "/"）`;
        excluded.push(base);
        continue;
      }
      if (c.secure && !securePage) {
        base.detail = `Secure cookie 仅在 https 页面可读，当前为明文 ${protocol}//`;
        excluded.push(base);
        continue;
      }
      // 脚本视角的最后一道：HttpOnly 对 document.cookie 不可见（不应用 SameSite）
      if (c.httpOnly) {
        base.detail =
          'HttpOnly cookie 对页面脚本的 document.cookie 不可见（不应用 SameSite 限制，但 HttpOnly 一律排除）；' +
          '该条目仍可由网络接口（/api/send）在请求头中发送';
        excluded.push(base);
        continue;
      }

      base.verdict = 'send';
      const hostWay = c.hostOnly ? '主机精确相等' : `主机 ${host} 命中域 ${c.domain}`;
      const partitionWay = c.partitioned ? `；分区键 ${partitionKey} 匹配（Partitioned）` : '';
      const thirdPartyWay =
        blockThirdParty && !sameSiteContext && c.partitioned
          ? '；屏蔽第三方 Cookie 已开启：跨站普通 Cookie 被排除，分区键匹配的 Partitioned 项豁免'
          : '';
      base.detail =
        `可读：${hostWay}；页面路径 "${path}" 命中 cookie-path "${c.path}"` +
        (c.secure ? '；https 满足 Secure' : '') +
        partitionWay +
        thirdPartyWay +
        '；非 HttpOnly 且不应用 SameSite';
      // 纯只读：不刷新最近访问时间
      readable.push(base);
    }

    // 可读项沿用请求头排序：Path 长度降序；相等时首次创建顺序升序
    readable.sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length;
      return a.index - b.index;
    });
    excluded.sort((a, b) => a.index - b.index);

    return {
      ok: true,
      pageUrl,
      host,
      path,
      securePage,
      topUrl,
      pageSite,
      topSite,
      sameSiteContext,
      blockThirdParty,
      partitionKey,
      cookieString: readable.map((i) => i.cookie).join('; '),
      readable,
      excluded,
    };
  }

  private scriptReadError(error: string, pageUrl: string, blockThirdParty: boolean = false): ScriptReadResult {
    return {
      ok: false,
      error,
      pageUrl,
      host: '',
      path: '',
      securePage: false,
      topUrl: '',
      pageSite: '',
      topSite: '',
      sameSiteContext: false,
      blockThirdParty,
      partitionKey: '',
      cookieString: '',
      readable: [],
      excluded: [],
    };
  }

  /** 当前罐内容（会话/未过期状态如实展示，不过滤过期项） */
  list(now: number = this.clockNow): CookieView[] {
    return this.views(now);
  }

  /** 容量设置快照与各可注册域用量 */
  capacity(): CapacityView {
    return this.capacityView();
  }

  /**
   * 更新容量设置（全局 + 各可注册域上限，单位：条目数；null/缺省表示不限），
   * 替换式更新，并对所有已配置上限的级别立即执行一次压力淘汰。
   */
  setCapacity(config: { globalLimit?: number | null; domainLimits?: Record<string, number> }, now: number = this.clockNow): {
    capacity: CapacityView;
    eviction: EvictionReport;
  } {
    this.globalLimit = config.globalLimit ?? null;
    this.domainLimits = new Map<string, number>();
    if (config.domainLimits) {
      for (const [rawKey, limit] of Object.entries(config.domainLimits)) {
        const key = canonicalizeDomain(rawKey);
        if (key.length > 0 && Number.isInteger(limit) && limit >= 0) {
          this.domainLimits.set(key, limit);
        }
      }
    }
    // 设置变更后立即按新上限执行一次：依次域级（每个已配置的域）、全局
    const stages: EvictionStage[] = [];
    for (const key of this.domainLimits.keys()) {
      stages.push(this.runStage(key, this.domainLimits.get(key) as number, now));
    }
    if (this.globalLimit !== null) {
      stages.push(this.runStage(null, this.globalLimit, now));
    }
    const eviction = this.assembleReport(stages);
    return { capacity: this.capacityView(), eviction };
  }

  reset(): void {
    this.cookies = [];
    this.nextIndex = 1;
    // 重置罐内容时同步重置演算时钟（回到服务启动时固定的时刻），便于从头复现时间线
    this.clockNow = this.clockStart;
    // 容量设置属于模拟参数，重置罐内容时保留，便于重复演算
  }

  /**
   * 导出场景快照：完整保存原始 Cookie 条目（含分区键、创建序号、创建/更新/最近访问
   * 时间）、容量规则、演算时钟起点与当前值、下一创建序号，并带格式标识与版本号。
   */
  snapshot(): JarSnapshot {
    const exportedAt = Date.now();
    return {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      exportedAt,
      exportedAtReadable: formatTime(exportedAt),
      cookies: this.cookies
        .slice()
        .sort((a, b) => a.creationIndex - b.creationIndex)
        .map((c) => ({ ...c })),
      nextIndex: this.nextIndex,
      capacity: {
        globalLimit: this.globalLimit,
        domainLimits: [...this.domainLimits.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([domain, limit]) => ({ domain, limit })),
      },
      clock: {
        startedAt: this.clockStart,
        now: this.clockNow,
      },
    };
  }

  /**
   * 导入场景快照：先对入参做完整校验（结构、时间范围、条目身份唯一性、序号一致性、
   * 枚举与布尔字段），任一不满足即抛错——此时旧罐、容量规则与时钟均不变；
   * 全部通过后才一次性替换全部状态。恢复是精确状态替换：不执行容量淘汰，
   * 过期项原样保留；恢复后的发送排序、默认 Lax 宽限与容量淘汰与导出前连续操作一致。
   */
  importSnapshot(input: unknown): SnapshotImportResult {
    const snapshot = validateSnapshot(input);

    // 校验全部通过后一次性替换（先构造新值再整体赋上，任何中途异常都不会留下半改状态）
    const cookies = snapshot.cookies.map((c) => ({ ...c }));
    const domainLimits = new Map<string, number>();
    for (const { domain, limit } of snapshot.capacity.domainLimits) {
      domainLimits.set(domain, limit);
    }
    this.cookies = cookies;
    this.nextIndex = snapshot.nextIndex;
    this.globalLimit = snapshot.capacity.globalLimit;
    this.domainLimits = domainLimits;
    this.clockStart = snapshot.clock.startedAt;
    this.clockNow = snapshot.clock.now;

    return {
      ok: true,
      restoredCount: cookies.length,
      domainLimitCount: domainLimits.size,
      globalLimit: this.globalLimit,
      clock: this.clock(),
      capacity: this.capacityView(),
      jar: this.views(this.clockNow),
      snapshot,
    };
  }

  // ---------------- 内部辅助 ----------------

  private findCookie(name: string, domain: string, path: string, partitionKey: string | null): StoredCookie | undefined {
    return this.cookies.find(
      (c) =>
        c.name === name &&
        c.domain === domain &&
        c.path === path &&
        c.partitionKey === partitionKey,
    );
  }

  /**
   * document.cookie 脚本赋值专用：按与 store() 主流程完全一致的规则计算存储身份
   * （domain 规范化 + 与主机校验、default-path、Partitioned 分区键），
   * 查找同身份（name, domain, path, partitionKey）且「未过期」的 HttpOnly 项。
   * 任何身份无法成立的情形（Domain 不匹配、Partitioned 缺/非法顶层 URL 等）返回 null，
   * 交给主流程原有的拒绝逻辑处理；已过期的 HttpOnly 项同样返回 null（不在脚本保护之列）。
   */
  private findHttpOnlyForScript(
    parsed: ParsedSetCookie,
    urlInfo: { host: string; protocol: string; path: string },
    topUrl: string | undefined,
    now: number,
  ): StoredCookie | null {
    const { host, path: urlPath } = urlInfo;

    let domain: string;
    if (parsed.domain === undefined) {
      domain = host;
    } else {
      domain = canonicalizeDomain(parsed.domain);
      if (domain.length === 0) return null;
      if (isIpAddress(host) || isIpAddress(domain)) {
        if (host !== domain) return null;
        domain = host;
      } else if (host !== domain && !host.endsWith(`.${domain}`)) {
        return null;
      }
    }

    const cookiePath =
      parsed.path === undefined || !parsed.path.startsWith('/')
        ? defaultPath(urlPath)
        : parsed.path;

    let partitionKey: string | null = null;
    if (parsed.partitioned) {
      const topRaw = typeof topUrl === 'string' ? topUrl.trim() : '';
      if (topRaw === '') return null;
      const partition = partitionKeyFromUrl(topRaw);
      if (!partition) return null;
      partitionKey = partition.key;
    }

    const existing = this.findCookie(parsed.name, domain, cookiePath, partitionKey);
    if (!existing || !existing.httpOnly) return null;
    const expired = existing.expiresAt !== undefined && existing.expiresAt <= now;
    return expired ? null : existing;
  }

  /**
   * SameSite 单项演算：返回 null 排除原因表示放行，并附带一句站点说明（用于发送项详情）。
   *  - Strict：仅同站；
   *  - 显式 Lax：同站，或跨站顶层导航的安全方法；
   *  - 默认 Lax：同上，另允许创建不超过 120 秒的跨站顶层 POST；
   *  - None：不限制站点（入罐时已强制 Secure）。
   */
  private sameSiteVerdict(
    c: StoredCookie,
    label: string,
    ctx: {
      sameSiteContext: boolean;
      siteCompare: string;
      topLevelNav: boolean;
      safeMethod: boolean;
      method: string;
      now: number;
    },
  ): { excludeReason: string | null; note: string } {
    const { sameSiteContext, siteCompare, topLevelNav, safeMethod, method, now } = ctx;

    if (sameSiteContext) {
      return { excludeReason: null, note: `SameSite=${label}：同站请求（${siteCompare}）` };
    }
    if (c.sameSite === 'none') {
      return { excludeReason: null, note: `SameSite=None：跨站照常发送（${siteCompare}，已强制 Secure）` };
    }
    if (c.sameSite === 'strict') {
      return {
        excludeReason: `SameSite=Strict：仅同站请求发送；当前跨站（${siteCompare}），不发送`,
        note: '',
      };
    }

    // 以下为跨站 Lax
    const modeText = c.sameSiteDefault ? 'Lax（默认）' : 'Lax（显式）';
    if (topLevelNav && safeMethod) {
      return {
        excludeReason: null,
        note: `SameSite=${modeText}：跨站放行——顶层导航的安全方法 ${method}（${siteCompare}）`,
      };
    }
    if (c.sameSiteDefault && topLevelNav && method === 'POST') {
      const ageMs = now - c.createdAt;
      if (ageMs <= LAX_POST_GRACE_MS) {
        const ageSec = Math.floor(ageMs / 1000);
        return {
          excludeReason: null,
          note: `SameSite=Lax（默认）：跨站放行——创建 ${ageSec} 秒 ≤ 120 秒宽限的顶层 POST（${siteCompare}）`,
        };
      }
      const ageSec = Math.floor(ageMs / 1000);
      return {
        excludeReason:
          `SameSite=Lax（默认）：跨站顶层 POST 的 120 秒宽限已过（已创建 ${ageSec} 秒），` +
          `且 POST 不是安全方法，不发送（${siteCompare}）`,
        note: '',
      };
    }
    if (!topLevelNav) {
      const allow = c.sameSiteDefault ? '顶层导航的安全方法或 120 秒内的顶层 POST' : '顶层导航的安全方法';
      return {
        excludeReason: `SameSite=${modeText}：跨站仅允许${allow}，当前为非顶层导航（子资源/iframe 等），不发送（${siteCompare}）`,
        note: '',
      };
    }
    // 顶层导航但方法不安全（显式 Lax 的任意方法，或默认 Lax 的非 POST 方法）
    const grace = c.sameSiteDefault ? '；120 秒宽限仅限 POST' : '';
    return {
      excludeReason:
        `SameSite=${modeText}：跨站顶层导航仅安全方法（GET/HEAD/OPTIONS/TRACE）可发，` +
        `当前方法 ${method}${grace}，不发送（${siteCompare}）`,
      note: '',
    };
  }

  private sendError(error: string, requestUrl: string, blockThirdParty: boolean = false): SendResult {
    return {
      ok: false,
      error,
      requestUrl,
      host: '',
      path: '',
      secureRequest: false,
      topUrl: '',
      method: '',
      topLevelNav: false,
      requestSite: '',
      topSite: '',
      sameSiteContext: false,
      blockThirdParty,
      partitionKey: '',
      cookieHeader: '',
      sent: [],
      excluded: [],
    };
  }

  private toView(c: StoredCookie, now: number): CookieView {
    const expired = c.expiresAt !== undefined && c.expiresAt <= now;
    return {
      index: c.creationIndex,
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: c.hostOnly,
      scope: c.hostOnly ? 'host-only' : `domain（含 *.${c.domain}）`,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      sameSiteDefault: c.sameSiteDefault,
      sameSiteLabel: sameSiteLabel(c.sameSite, c.sameSiteDefault),
      priority: c.priority,
      priorityDefault: c.priorityDefault,
      priorityLabel: priorityLabel(c.priority, c.priorityDefault),
      partitioned: c.partitioned,
      partitionKey: c.partitionKey,
      partitionLabel: partitionLabel(c.partitioned, c.partitionKey),
      persistent: c.expiresAt !== undefined,
      expiresAt: c.expiresAt === undefined ? null : formatTime(c.expiresAt),
      remaining: c.expiresAt === undefined ? null : expired ? '已过期' : formatRemaining(c.expiresAt, now),
      expired,
      createdAt: formatTime(c.createdAt),
      updatedAt: formatTime(c.updatedAt),
      lastAccessedAt: formatTime(c.lastAccessedAt),
    };
  }

  private views(now: number): CookieView[] {
    return [...this.cookies]
      .sort((a, b) => a.creationIndex - b.creationIndex)
      .map((c) => this.toView(c, now));
  }

  private result(
    ok: boolean,
    action: StoreAction,
    reason: string,
    notices: string[],
    _parsed?: ParsedSetCookie,
    stored?: StoredCookie,
    eviction: EvictionReport | null = null,
    now: number = this.clockNow,
  ): StoreResult {
    return {
      ok,
      action,
      reason,
      notices,
      cookie: stored ? this.toView(stored, now) : null,
      jar: this.views(now),
      eviction,
    };
  }

  // ---------------- 容量压力淘汰 ----------------

  /** 入罐后执行压力淘汰：域级（仅新条目所属可注册域，若设了上限）→ 全局（若设了上限） */
  private enforceAfterStore(stored: StoredCookie, now: number): EvictionReport | null {
    const stages: EvictionStage[] = [];
    const regDomain = registrableDomain(stored.domain);
    const domainLimit = this.domainLimits.get(regDomain);
    if (domainLimit !== undefined) {
      stages.push(this.runStage(regDomain, domainLimit, now));
    }
    if (this.globalLimit !== null) {
      stages.push(this.runStage(null, this.globalLimit, now));
    }
    return stages.length ? this.assembleReport(stages) : null;
  }

  /** 组装汇总报告（removed 保持各阶段内的实际移除顺序） */
  private assembleReport(stages: EvictionStage[]): EvictionReport {
    const removed = stages.flatMap((s) => s.removed);
    return {
      basis: EVICTION_BASIS,
      triggered: removed.length > 0,
      stages,
      removed,
    };
  }

  /**
   * 执行一个级别的压力淘汰：
   *  domain === null 表示全局；否则只看 cookie 的可注册域 === domain 的条目。
   * 条数不超限时完全不动（不预清过期项）；超限时先清理过期项，再按
   * Priority 低→高、最近访问早→晚、创建序号小→大淘汰，直到回到上限。
   */
  private runStage(domain: string | null, limit: number, now: number): EvictionStage {
    const scopeName = domain === null ? '全局' : `域 ${domain}`;
    const inScope = (c: StoredCookie): boolean =>
      domain === null || registrableDomain(c.domain) === domain;
    const scoped = this.cookies.filter(inScope);
    const beforeCount = scoped.length;

    const stage: EvictionStage = {
      scope: domain === null ? 'global' : 'domain',
      domain,
      limit,
      beforeCount,
      expiredRemoved: 0,
      evictedCount: 0,
      afterCount: beforeCount,
      triggered: false,
      removed: [],
    };

    if (beforeCount <= limit) {
      return stage;
    }

    // 1) 先物理清理范围内已过期项
    const expiredCookies = scoped.filter(
      (c) => c.expiresAt !== undefined && c.expiresAt <= now,
    );
    for (const c of expiredCookies) {
      stage.removed.push(this.toEvicted(c, now, 'expired', `已过期（${formatTime(c.expiresAt as number)}），先于容量淘汰被清理（${scopeName}）`));
    }
    if (expiredCookies.length) {
      const expiredSet = new Set(expiredCookies);
      this.cookies = this.cookies.filter((c) => !expiredSet.has(c));
      stage.expiredRemoved = expiredCookies.length;
    }

    // 2) 仍超限时，按优先级 → 最近访问 → 创建序号 淘汰
    let remaining = this.cookies.filter(inScope);
    const overflow = remaining.length - limit;
    if (overflow > 0) {
      const victims = [...remaining].sort(this.compareEviction).slice(0, overflow);
      const victimSet = new Set(victims);
      for (const c of victims) {
        stage.removed.push(
          this.toEvicted(
            c,
            now,
            'evicted',
            `容量淘汰（${scopeName}，上限 ${limit}）：Priority=${priorityLabel(c.priority, c.priorityDefault)}，` +
            `最近访问 ${formatTime(c.lastAccessedAt)}，创建序号 #${c.creationIndex}，在「${EVICTION_BASIS}」中排最前`,
          ),
        );
      }
      this.cookies = this.cookies.filter((c) => !victimSet.has(c));
      stage.evictedCount = victims.length;
      remaining = this.cookies.filter(inScope);
    }

    stage.afterCount = remaining.length;
    stage.triggered = stage.removed.length > 0;
    return stage;
  }

  /** 淘汰排序：优先级低 → 高；同级最近访问早 → 晚；再同则创建序号小 → 大 */
  private compareEviction(a: StoredCookie, b: StoredCookie): number {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    if (a.lastAccessedAt !== b.lastAccessedAt) return a.lastAccessedAt - b.lastAccessedAt;
    return a.creationIndex - b.creationIndex;
  }

  private toEvicted(
    c: StoredCookie,
    now: number,
    reason: 'expired' | 'evicted',
    basis: string,
  ): EvictedCookie {
    const expired = c.expiresAt !== undefined && c.expiresAt <= now;
    return {
      index: c.creationIndex,
      name: c.name,
      value: c.value,
      cookie: `${c.name}=${c.value}`,
      domain: c.domain,
      hostOnly: c.hostOnly,
      path: c.path,
      priority: c.priority,
      priorityLabel: priorityLabel(c.priority, c.priorityDefault),
      partitioned: c.partitioned,
      partitionKey: c.partitionKey,
      expired,
      lastAccessedAt: formatTime(c.lastAccessedAt),
      reason,
      basis,
    };
  }

  /** 把淘汰汇总追加为入罐提示（界面 notices 与淘汰清单都会显示） */
  private appendEvictionNotices(notices: string[], report: EvictionReport | null): void {
    if (!report) return;
    for (const stage of report.stages) {
      if (!stage.triggered) continue;
      const where = stage.scope === 'global' ? '全局' : `可注册域 ${stage.domain ?? ''}`;
      if (stage.expiredRemoved > 0) {
        notices.push(`${where}容量检查：超限（${stage.beforeCount} > ${stage.limit}），先清理 ${stage.expiredRemoved} 条已过期项`);
      }
      if (stage.evictedCount > 0) {
        notices.push(`${where}容量淘汰：${stage.evictedCount} 条被逐出（${EVICTION_BASIS}），剩余 ${stage.afterCount}/${stage.limit}`);
      }
    }
  }

  /** 容量快照：全局上限 + 各域上限，及按可注册域聚合的当前用量 */
  private capacityView(): CapacityView {
    const counts = new Map<string, number>();
    for (const c of this.cookies) {
      const key = registrableDomain(c.domain);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = new Set<string>([...counts.keys(), ...this.domainLimits.keys()]);
    const usage = [...keys]
      .sort()
      .map((domain) => ({
        domain,
        count: counts.get(domain) ?? 0,
        limit: this.domainLimits.has(domain) ? (this.domainLimits.get(domain) as number) : null,
      }));
    return {
      globalLimit: this.globalLimit,
      domainLimits: [...this.domainLimits.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([domain, limit]) => ({ domain, limit })),
      totalCount: this.cookies.length,
      usage,
    };
  }
}

// ---------------- 场景快照校验 ----------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v);

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const SAME_SITE_VALUES = new Set<SameSiteMode>(['strict', 'lax', 'none']);
const PRIORITY_VALUES = new Set<CookiePriority>(['low', 'medium', 'high']);

/**
 * 完整校验一份场景快照，通过后返回规范化（深拷贝、域名规范化）的快照；
 * 任一问题都抛出带定位信息的错误。校验覆盖：
 *  - 结构：顶层格式标识 / 版本 / 各字段类型；
 *  - 时间范围：时钟 now ≥ startedAt（整秒差），条目的创建/更新/最近访问时间
 *    均落在 [startedAt, now]，过期时间为非负整数，推进语义不允许时间倒流；
 *  - 条目身份唯一性：(name, domain, path, partitionKey) 不得重复，创建序号也不得重复；
 *  - 序号一致性：创建序号为 ≥1 的整数且全部小于 nextIndex；
 *  - 枚举 / 布尔字段、SameSite=None 必须 Secure、Partitioned 必须带非空分区键
 *    （未分区必须为 null）、容量上限为 ≥1 的整数等。
 */
export function validateSnapshot(input: unknown): JarSnapshot {
  if (!isObject(input)) {
    throw new Error('快照必须是 JSON 对象（收到的不是对象/数组无法解析），导入已取消，罐内容、容量与时钟均未改动');
  }
  if (input.format !== SNAPSHOT_FORMAT) {
    throw new Error(`快照格式标识不符：缺少或错误的 format（应为 "${SNAPSHOT_FORMAT}"），导入已取消，旧罐、容量和时钟均不变`);
  }
  if (input.version !== SNAPSHOT_VERSION) {
    throw new Error(`快照版本不受支持：version=${String(input.version)}，本版本仅支持 ${SNAPSHOT_VERSION}（请勿手工伪造或用其它版本的文件导入）；旧罐、容量和时钟均不变`);
  }
  if (!isInt(input.exportedAt) || input.exportedAt < 0) {
    throw new Error('快照元信息 exportedAt 必须是非负整数时间戳；旧罐、容量和时钟均不变');
  }
  if (!Array.isArray(input.cookies)) {
    throw new Error('快照字段 cookies 必须是数组；旧罐、容量和时钟均不变');
  }
  if (!isInt(input.nextIndex) || input.nextIndex < 1) {
    throw new Error('快照字段 nextIndex（下一创建序号）必须是不小于 1 的整数；旧罐、容量和时钟均不变');
  }
  if (!isObject(input.capacity)) {
    throw new Error('快照字段 capacity 必须是对象；旧罐、容量和时钟均不变');
  }
  if (!isObject(input.clock)) {
    throw new Error('快照字段 clock 必须是对象；旧罐、容量和时钟均不变');
  }

  // ---- 时钟：起点 / 当前值 / 整秒推进 ----
  const { startedAt, now } = input.clock as Record<string, unknown>;
  if (!isInt(startedAt) || startedAt < 0) {
    throw new Error('快照时钟 startedAt（演算起点）必须是非负整数毫秒时间戳；旧罐、容量和时钟均不变');
  }
  if (!isInt(now) || now < 0) {
    throw new Error('快照时钟 now（当前演算时间）必须是非负整数毫秒时间戳；旧罐、容量和时钟均不变');
  }
  if (now < startedAt) {
    throw new Error(`快照时间范围非法：时钟当前值 ${now} 早于起点 ${startedAt}（演算时钟只能向前推进）；旧罐、容量和时钟均不变`);
  }
  if ((now - startedAt) % 1000 !== 0) {
    throw new Error('快照时钟非法：当前值与起点之差不是整秒数（演算时钟只能按正整数秒推进）；旧罐、容量和时钟均不变');
  }

  // ---- 容量规则 ----
  const { globalLimit, domainLimits } = input.capacity as Record<string, unknown>;
  if (globalLimit !== null && (!isInt(globalLimit) || globalLimit < 1)) {
    throw new Error('快照容量 globalLimit 必须为 null（不限）或不小于 1 的整数；旧罐、容量和时钟均不变');
  }
  if (!Array.isArray(domainLimits)) {
    throw new Error('快照容量 domainLimits 必须是 [{ domain, limit }] 数组；旧罐、容量和时钟均不变');
  }
  const normalizedDomainLimits: Array<{ domain: string; limit: number }> = [];
  const domainLimitKeys = new Set<string>();
  domainLimits.forEach((entry, i) => {
    const where = `capacity.domainLimits[${i}]`;
    if (!isObject(entry)) {
      throw new Error(`快照容量规则第 ${i + 1} 项不是对象（${where}）；旧罐、容量和时钟均不变`);
    }
    if (typeof entry.domain !== 'string' || entry.domain.trim() === '') {
      throw new Error(`快照容量规则第 ${i + 1} 项的 domain 必须是非空字符串；旧罐、容量和时钟均不变`);
    }
    const domain = canonicalizeDomain(entry.domain);
    if (!isInt(entry.limit) || entry.limit < 1) {
      throw new Error(`快照容量规则域 ${domain} 的 limit 必须是不小于 1 的整数；旧罐、容量和时钟均不变`);
    }
    if (domainLimitKeys.has(domain)) {
      throw new Error(`快照容量规则中域 ${domain} 重复出现；旧罐、容量和时钟均不变`);
    }
    domainLimitKeys.add(domain);
    normalizedDomainLimits.push({ domain, limit: entry.limit });
  });

  // ---- 逐条 Cookie ----
  const cookies: SnapshotCookie[] = [];
  const identityKeys = new Set<string>();
  const indexKeys = new Set<number>();

  input.cookies.forEach((raw, i) => {
    const label = `cookies[${i}]（第 ${i + 1} 条）`;
    if (!isObject(raw)) {
      throw new Error(`快照${label}不是对象；旧罐、容量和时钟均不变`);
    }

    const requireString = (key: string): string => {
      const v = raw[key];
      if (typeof v !== 'string') {
        throw new Error(`快照${label}的 ${key} 必须是字符串；旧罐、容量和时钟均不变`);
      }
      return v;
    };
    const requireBool = (key: string): boolean => {
      const v = raw[key];
      if (!isBool(v)) {
        throw new Error(`快照${label}的 ${key} 必须是布尔值 true/false；旧罐、容量和时钟均不变`);
      }
      return v;
    };
    const requireTime = (key: string): number => {
      const v = raw[key];
      if (!isInt(v) || v < 0) {
        throw new Error(`快照${label}的 ${key} 必须是非负整数毫秒时间戳；旧罐、容量和时钟均不变`);
      }
      return v;
    };

    const name = requireString('name');
    if (name.length === 0 || !VALID_NAME_RE.test(name)) {
      throw new Error(`快照${label}的 name 非法（需为 RFC 6265 token，非空）："${name}"；旧罐、容量和时钟均不变`);
    }
    const value = requireString('value');

    const rawDomain = requireString('domain');
    const domain = canonicalizeDomain(rawDomain);
    if (domain.length === 0) {
      throw new Error(`快照${label}的 domain 规范化后为空："${rawDomain}"；旧罐、容量和时钟均不变`);
    }
    const path = requireString('path');
    if (!path.startsWith('/')) {
      throw new Error(`快照${label}的 path 必须是以 "/" 开头的绝对路径："${path}"；旧罐、容量和时钟均不变`);
    }

    const hostOnly = requireBool('hostOnly');
    const secure = requireBool('secure');
    const httpOnly = requireBool('httpOnly');
    const sameSiteDefault = requireBool('sameSiteDefault');
    const priorityDefault = requireBool('priorityDefault');
    const partitioned = requireBool('partitioned');

    const sameSite = requireString('sameSite');
    if (!SAME_SITE_VALUES.has(sameSite as SameSiteMode)) {
      throw new Error(`快照${label}的 sameSite 只能是 strict/lax/none："${sameSite}"；旧罐、容量和时钟均不变`);
    }
    const priority = requireString('priority');
    if (!PRIORITY_VALUES.has(priority as CookiePriority)) {
      throw new Error(`快照${label}的 priority 只能是 low/medium/high："${priority}"；旧罐、容量和时钟均不变`);
    }
    if (sameSite === 'none' && !secure) {
      throw new Error(`快照${label}自相矛盾：SameSite=None 的条目必须 Secure=true；旧罐、容量和时钟均不变`);
    }

    // 分区键：分区项必须带非空字符串；未分区项必须为 null
    const partitionKeyRaw = raw.partitionKey;
    let partitionKey: string | null;
    if (partitioned) {
      if (typeof partitionKeyRaw !== 'string' || partitionKeyRaw.trim() === '') {
        throw new Error(`快照${label}标记为 Partitioned，partitionKey 必须是非空字符串（scheme + 可注册域）；旧罐、容量和时钟均不变`);
      }
      if (!secure) {
        throw new Error(`快照${label}自相矛盾：Partitioned 条目必须 Secure=true；旧罐、容量和时钟均不变`);
      }
      partitionKey = partitionKeyRaw;
    } else {
      if (partitionKeyRaw !== null) {
        throw new Error(`快照${label}未分区（partitioned=false），partitionKey 必须为 null；旧罐、容量和时钟均不变`);
      }
      partitionKey = null;
    }

    // 序号：正整数、唯一、且严格小于 nextIndex
    const creationIndex = raw.creationIndex;
    if (!isInt(creationIndex) || creationIndex < 1) {
      throw new Error(`快照${label}的 creationIndex 必须是不小于 1 的整数；旧罐、容量和时钟均不变`);
    }
    if (creationIndex >= (input.nextIndex as number)) {
      throw new Error(`快照${label}的 creationIndex=${creationIndex} 不小于 nextIndex=${input.nextIndex as number}（序号一致性：下一序号必须大于全部已有序号）；旧罐、容量和时钟均不变`);
    }
    if (indexKeys.has(creationIndex)) {
      throw new Error(`快照中创建序号 ${creationIndex} 重复出现（#${creationIndex}）；条目序号必须唯一；旧罐、容量和时钟均不变`);
    }
    indexKeys.add(creationIndex);

    // 身份唯一性：(name, domain, path, partitionKey)
    const identity = `${name} ${domain} ${path} ${partitionKey === null ? '' : partitionKey}`;
    if (identityKeys.has(identity)) {
      const partText = partitionKey === null ? '未分区' : `分区 ${partitionKey}`;
      throw new Error(
        `快照中存在身份重复的条目：${name}（domain=${domain}，path=${path}，${partText}）` +
        `——(name, domain, path, 分区键) 必须唯一；旧罐、容量和时钟均不变`,
      );
    }
    identityKeys.add(identity);

    // 时间范围：创建/更新/最近访问都在 [起点, 当前值] 内
    const createdAt = requireTime('createdAt');
    const updatedAt = requireTime('updatedAt');
    const lastAccessedAt = requireTime('lastAccessedAt');
    for (const [tKey, tVal] of [
      ['createdAt', createdAt],
      ['updatedAt', updatedAt],
      ['lastAccessedAt', lastAccessedAt],
    ] as const) {
      if (tVal < startedAt || tVal > now) {
        throw new Error(
          `快照${label}的 ${tKey}=${tVal} 超出时钟范围 [${startedAt}, ${now}]` +
          `（条目时间不得早于时钟起点，也不得晚于当前值）；旧罐、容量和时钟均不变`,
        );
      }
    }

    // expiresAt：省略或 null = 会话 cookie；否则为非负整数
    let expiresAt: number | undefined;
    if (raw.expiresAt !== undefined && raw.expiresAt !== null) {
      const exp = raw.expiresAt;
      if (!isInt(exp) || exp < 0) {
        throw new Error(`快照${label}的 expiresAt 必须是非负整数毫秒时间戳，或省略/null 表示会话 cookie；旧罐、容量和时钟均不变`);
      }
      expiresAt = exp;
    }

    cookies.push({
      name,
      value,
      domain,
      path,
      hostOnly,
      secure,
      httpOnly,
      sameSite: sameSite as SameSiteMode,
      sameSiteDefault,
      priority: priority as CookiePriority,
      priorityDefault,
      partitioned,
      partitionKey,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      creationIndex,
      createdAt,
      updatedAt,
      lastAccessedAt,
    });
  });

  cookies.sort((a, b) => a.creationIndex - b.creationIndex);

  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    exportedAt: input.exportedAt,
    exportedAtReadable: formatTime(input.exportedAt),
    cookies,
    nextIndex: input.nextIndex as number,
    capacity: {
      globalLimit: globalLimit as number | null,
      domainLimits: normalizedDomainLimits,
    },
    clock: {
      startedAt: startedAt as number,
      now: now as number,
    },
  };
}
