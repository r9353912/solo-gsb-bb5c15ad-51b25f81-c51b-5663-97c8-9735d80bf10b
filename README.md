# 🍪 Cookie 罐演算 Web 工具 · Cookie Jar Lab

一个用于**演算 HTTP Cookie 写入与发送规则**的教学/调试 Web 工具：你按顺序提交
「响应 URL + 单条 Set-Cookie」，服务端按 [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265)
更新内存 Cookie 罐；再输入请求 URL（以及顶层页面 URL、方法、是否顶层导航），即可看到生成的
`Cookie` 请求头，以及每一项**被发送或被排除的具体原因**（含 SameSite 站点演算）。

此外支持 **Cookie Priority 与容量压力模拟**：为每个可注册域与全局设置条目数上限，
观察入罐时「先域级、后全局」的淘汰过程——先清过期项，再按
**优先级低 → 高、最近访问早 → 晚、创建序号小 → 大**逐条淘汰，并给出完整淘汰清单与排序依据。

还支持 **Partitioned（CHIPS 独立分区 cookie）**：带 `Partitioned` 的 Set-Cookie 仅在同时带
`Secure`、且写入时提供有效 http(s) 顶层页面 URL 时入罐，**分区键 = 该 URL 的 scheme +
可注册域**（IP、localhost 用完整主机）；普通项与不同分区的同名同域同路径项并存，
发送时只随分区键相同的顶层页面发送，其余分区项在排除明细中说明原因。

另有可选的 **屏蔽第三方 Cookie** 模式（默认关闭，界面开关对应 API 的 `blockThirdParty`
参数）：开启后必须提供有效顶层页面 URL，按 **scheme + 可注册域** 判定它与响应/请求 URL
是否跨站——**跨站响应拒绝写入和删除普通 Cookie**（不改动罐、不触发容量淘汰），
Partitioned 分区项仍按既有 Secure 与分区键规则正常入罐；**跨站请求排除普通 Cookie**
（被排除条目不刷新最近访问时间），分区键匹配的 Partitioned 项仍可发送；
拒绝/排除结果逐项说明策略原因。

还有右栏的 **📜 document.cookie 脚本演算** 面板（对应 `POST /api/script/read` 与
`POST /api/script/write`），模拟**页面里的 JavaScript** 读写 `document.cookie`：

- **读取**入参为页面 URL、顶层页面 URL、第三方屏蔽开关；按既有
  过期 → 分区（Partitioned 分区键）→ 第三方屏蔽 → Domain → Path → Secure 顺序筛选，
  **最后再排除 HttpOnly**（`document.cookie` 对脚本不可见）；**不应用 SameSite**，
  **不刷新最近访问时间**（纯只读、罐内容不变）；可读项沿用请求头排序
  （Path 长度降序、创建序号升序），逐项给出可读 / 不可读原因，并以 `; ` 拼成读取字符串。
- **写入**复用现有解析、分区身份与容量淘汰逻辑，但**拒绝带 HttpOnly 的赋值**，也
  **拒绝覆盖或以 `Max-Age<=0` 删除同身份（name、domain、path、分区键相同）且未过期的
  HttpOnly 项**（已过期的不在保护之列）；拒绝都在改动罐之前返回，
  **罐内容、时间戳与容量保持不变**。
- **网络接口 `/api/store`、`/api/send` 行为不变**：仍可写入、更新、删除并在请求头中
  发送 HttpOnly 项（HttpOnly 只阻挡页面脚本，不阻挡网络栈）。

内置 **⏱ 演算时钟（可控时间轴）**：服务启动时把当前真实时间固定为演算时钟起点，
之后**不随真实时间流动**，只能经界面或 `POST /api/clock/advance` 按**正整数秒**推进
（非法输入被拒绝且时钟与罐均不变）。网络写入/发送、`document.cookie` 读写、罐快照与
容量淘汰统一使用该时钟——**Max-Age 过期、默认 Lax 的 120 秒跨站顶层 POST 宽限、
过期清理**都可以逐秒步进复现；**推进本身不删除条目**（过期项留在罐中标灰展示，
下次匹配或容量淘汰时再按既有规则处理），**重置罐时时钟同步回到启动时刻**。

还提供 **📦 场景快照**（「🫙 当前 Cookie 罐」面板的 **快照下载 / 快照导入**，对应
`GET /api/snapshot` 与 `POST /api/snapshot/import`）：导出带**格式标识与版本号**的
JSON，完整保存**原始 Cookie 条目**（含分区键、创建序号、创建/更新/最近访问时间等
全部字段）、**容量规则**（全局与每可注册域上限）、**演算时钟起点与当前值**及
**下一创建序号**。导入时**先完整校验**（结构、时间范围、条目身份唯一性、序号
一致性、枚举约束），全部通过后才**一次性替换罐、容量规则与时钟**——任一校验失败
返回 400，**旧罐、容量和时钟均不变**。恢复是精确状态替换、**不执行容量淘汰**：
**过期项原样保留**，恢复后的发送排序、默认 Lax 宽限与容量淘汰与导出前的连续操作
完全一致。

技术栈：**TypeScript + Express + 原生 HTML/CSS/JS**（前端无框架、无构建），数据仅存内存；
same-site 判定使用 [tldts](https://github.com/remusao/tldts)（内置公共后缀列表 PSL，含私有域段）。

---

## 🚀 单条启动命令（Docker Compose）

前置条件：安装 **Docker**（含 Compose 插件，Docker Desktop 或 Docker Engine +
`docker-compose-plugin` 均可）。无需本机安装 Node.js。

在**项目根目录**执行这一条命令即可完成构建并在后台启动 Web/API：

```bash
docker compose up --build -d
```

启动后浏览器访问：

> **http://localhost:3000**

- Web 界面与全部 API（`/api/store`、`/api/send`、`/api/clock`、`/api/snapshot` 等）都在 **同一端口 localhost:3000** 提供；
  - Web 界面：**http://localhost:3000/**
  - API 根路径：**http://localhost:3000/api/...**（如 `GET http://localhost:3000/api/jar`、`GET http://localhost:3000/api/snapshot`）
- 容器内服务端口：**3000**（由 `docker-compose.yml` 的 `PORT=3000` 环境变量指定）；
- 宿主机默认映射端口：**3000**（想换端口改 `docker-compose.yml` 左侧，如 `"3001:3000"`，同时把 `environment` 里的 `PORT` 保持为容器内监听端口 `3000` 即可；本机直跑可用 `PORT=3001 npm start` 指定监听端口）。
- **必要配置**：仅一个可选环境变量 `PORT`（缺省 3000）；无需数据库或外部依赖，Cookie 状态只存进程内存（快照导入/导出是唯一的状态迁移方式）。

常用命令：

```bash
docker compose logs -f          # 跟踪服务日志（看到「🍪 Cookie Jar Lab 已启动」即就绪）
docker compose ps               # 查看运行状态
docker compose down             # 停止并删除容器（镜像保留）
docker compose down --rmi local # 同时删除本工具镜像
docker compose up --build -d    # 改完代码后重新构建并启动
```

> 不想用 Docker？见文末[不用 Docker 的本地运行](#不用-docker-的本地运行)。

---

## 🧭 使用流程

界面分为三步：

1. **写入 Set-Cookie**（可重复执行，模拟多个响应、按顺序入罐）
   - 填「响应 URL」（cookie 来源页面），如 `https://shop.example.com/admin/dashboard?tab=1`
   - 填「单条 Set-Cookie」（**不要**带 `Set-Cookie:` 前缀），如：
     `session=abc123; Domain=example.com; Path=/; Max-Age=3600; Secure`
   - 当 Set-Cookie 带 **`Partitioned`**（CHIPS）时，还需填「顶层页面 URL」
     （如嵌入方页面 `https://embed.example.net/`）：分区键取它的 scheme + 可注册域；
     普通 cookie 该栏留空即可
   - 可勾选 **屏蔽第三方 Cookie**（默认关闭）：开启后顶层页面 URL 必填，
     跨站响应的普通 Cookie 拒绝写入/删除（Partitioned 分区项不受影响）
   - 点击 **入罐**，查看入罐 / 更新 / 删除 / 拒绝结果与原因
2. **发起请求**：填请求 URL（如 `https://api.shop.example.com/orders/123/detail`），
   并可指定 SameSite / 分区判定上下文——**顶层页面 URL**（留空 = 与请求 URL 同站/同分区）、
   **请求方法**、**是否顶层导航**；可勾选 **屏蔽第三方 Cookie**（默认关闭，开启后顶层页面
   URL 必填，跨站请求排除普通 Cookie，分区键匹配的 Partitioned 项仍可发送）。
   点击 **生成 Cookie 头**，查看：
   - 最终 `Cookie:` 请求头（可一键复制）与本请求的**分区键**
   - 请求站 vs 顶层站（scheme + 可注册域）的同站/跨站结论与第三方屏蔽开关状态
   - 📤 **发送项**：命中的主机 / Path / Secure / SameSite / 分区键匹配点
   - 🚫 **排除项**：过期、Domain 不匹配、Path 不匹配、Secure 受限、SameSite 拦截、
     **分区键不符（Partitioned）**、**第三方屏蔽（跨站普通 Cookie）**等逐项原因
3. **🫙 当前 Cookie 罐**：右侧表格实时展示全部条目（域、作用域、Path、**分区键**、Secure、
   Priority、有效期剩余、创建序号、**最近访问时间**）；点击 **重置** 清空内存罐。
4. **🎚️ 容量压力模拟**（右栏顶部）：设置**全局容量**与**每个可注册域的容量**（按条目条数，
   留空 = 不限），点击 **应用容量设置** 立即按新上限执行一次淘汰；之后每次入罐通过校验都会
   自动依次执行域级、全局淘汰。面板中实时显示全局与各域用量（`当前条数/上限`），
   入罐结果区会展示**本次触发的淘汰清单**（过期清理 / 容量淘汰、逐条排序依据）。
5. **📜 document.cookie 脚本演算**（右栏中部，模拟页面 JS）：
   - 填**页面 URL**（执行脚本的文档地址）与**顶层页面 URL**（留空 = 同站 / 同分区），
     可勾选**屏蔽第三方 Cookie**（开启后顶层页必填，跨站页面读不到普通 Cookie）；
   - 点击 **读取 document.cookie**：查看脚本读到的字符串（可一键复制）、页面站 / 顶层站、
     页面分区键，以及 👁 可读项与 🚫 不可读项的逐项原因（**HttpOnly 一律排除**、
     **不应用 SameSite**；过期、分区键不符、第三方屏蔽、Domain / Path / Secure 不匹配同样逐条说明）；
     该操作是**纯只读**，不刷新任何条目的最近访问时间；
   - 在**赋值串**栏填写单条 cookie 赋值（与 Set-Cookie 同语法，**不要**带 `document.cookie =` 前缀），
     点击 **执行 document.cookie 赋值**：普通 cookie 正常入罐 / 覆盖 / 删除并走容量淘汰；
     但**带 `HttpOnly` 的赋值**、以及**覆盖或 `Max-Age<=0` 删除同身份未过期 HttpOnly 项**
     都会被**拒绝**，拒绝时罐内容、时间戳与容量均不变（结果区会明确说明）。
     HttpOnly 项仍可通过第 1 步的网络写入 `/api/store` 改写，也仍会出现在第 2 步的请求头中。
6. **⏱ 演算时钟**（右栏顶部）：面板显示**当前演算时间**、启动时刻与已推进秒数。
   服务启动时时钟固定，不随真实时间流动；在输入框填**正整数秒**点击 **推进**
   （对应 `POST /api/clock/advance`），罐表格中的剩余有效期 / 过期标灰随即按新时间刷新。
   非法输入（0、负数、非整数、非数字）被拒绝且**时钟与罐均不变**；
   **推进本身不删除条目**，过期项留待下次匹配或容量淘汰处理；
   点击 **重置** 清空罐时，时钟同步回到启动时刻。
7. **📦 场景快照**（右栏「🫙 当前 Cookie 罐」面板顶部）：
   - 点击 **⬇ 快照下载**（或 `GET /api/snapshot`）：浏览器保存一个
     `cookie-jar-snapshot-<时间戳>.json` 文件，内含带 `format` / `version` 的完整场景：
     全部**原始 Cookie 条目**（含分区键、创建序号、创建/更新/最近访问时间，过期项也在）、
     **容量规则**、**演算时钟起点与当前值**、**下一创建序号**；
   - 点击 **⬆ 快照导入**选择该 JSON（或 `POST /api/snapshot/import`）：服务端**先完整
     校验**——结构与字段类型、**时间范围**（时钟当前值 ≥ 起点且为整秒推进；条目时间均在
     起点与当前值之间）、**条目身份唯一性**（name/domain/path/分区键不重复、创建序号不
     重复）、**序号一致性**（创建序号 ≥1 且严格小于下一序号）及 SameSite=None 必带
     Secure、Partitioned 必带分区键等约束；任一不满足返回 400 并在面板显示原因，
     **旧罐、容量和时钟均不变**；
   - 校验通过后**一次性替换全部状态**并刷新罐表格、容量面板与时钟面板：
     **过期项原样保留**（不执行容量淘汰），之后的发送排序（Path 长度 / 创建序号）、
     默认 Lax 的 120 秒跨站顶层 POST 宽限（按首次创建时间）与容量淘汰
     （Priority / 最近访问 / 创建序号）都与**导出前继续操作**完全一致，新写入条目
     从快照的下一序号继续编号；
   - 快照只存内存状态、不含任何密钥，可放心用于保存课堂演示场景或在浏览器/容器间迁移。

### 容量淘汰的顺序

每次入罐（含覆盖更新）通过既有全部校验后，按以下顺序处理压力：

1. **域级淘汰**：仅针对新条目所属的**可注册域**（eTLD+1；IP / localhost 按完整主机），
   且仅当该域设置了容量上限；
2. **全局淘汰**：随后针对全罐，且仅当设置了全局限额。

每一级超限时（范围内条数 > 上限）：

1. **先物理清理范围内已过期的条目**；
2. 若仍超限，把存活条目依次按
   **Priority 从低到高（Low → Medium → High）→ 最近访问时间从早到晚 → 创建序号从小到大**
   排序，从最前开始逐条淘汰，直到条数回到上限；
3. 新入罐的条目自身也可能立刻被淘汰（结果中会明确提示）。

**最近访问时间（LRA）**在创建 / 覆盖更新时写入；条目在请求演算中**发送成功**即刷新。
修改容量设置时，会对所有已配置的上限（域级逐个、随后全局）立即执行一轮上述流程。

### 推荐演算示例（按顺序）

| # | 响应 URL | Set-Cookie | 预期 |
|---|----------|-----------|------|
| 1 | `https://shop.example.com/admin/dashboard` | `sid=host123; Path=/admin; Max-Age=600` | 入罐（host-only，默认 Path 这里被属性指定为 `/admin`） |
| 2 | `https://shop.example.com/admin/dashboard` | `tracker=xyz; Max-Age=3600` | 入罐（host-only，**默认 Path=/admin**，SameSite 记为默认 Lax） |
| 3 | `https://example.com/` | `prefs=a=1; Domain=example.com; Path=/` | 入罐（Domain cookie，覆盖 `example.com` 及所有子域） |
| 4 | `http://evil.example.org/` | `bad=nope; Domain=example.com` | **拒绝**：Domain 不匹配响应主机 |
| 5 | `https://shop.example.com/admin/dashboard` | `tracker=; Max-Age=0` | **删除**同名同域同路径的 tracker |
| 6 | `https://example.com/` | `secure=1; Path=/; Secure` | 入罐（仅 https 发送） |
| 7 | `https://example.com/` | `strict=1; Path=/; SameSite=STRICT` | 入罐（SameSite 大小写不敏感 → Strict） |
| 8 | `https://example.com/` | `xs=1; Path=/; SameSite=None` | **拒绝**：SameSite=None 未带 Secure |
| 9 | `https://example.com/` | `xs=1; Path=/; Secure; SameSite=None` | 入罐（跨站也发送，但仅 https） |
| 10 | `https://example.com/` | `weird=1; Path=/; SameSite=Banana` | 入罐（非法值 → **默认 Lax** 并提示） |
| 11 | `https://example.com/` | `cart=1; Path=/; Priority=Low` | 入罐（Priority=Low；容量超限时最先被淘汰） |
| 12 | `https://example.com/` | `vip=1; Path=/; Priority=Nope` | 入罐（Priority 非法 → **Medium** 并提示） |
| 13 | `https://widget.vendor.com/frame`（顶层页 `https://site-a.example/`） | `ch=1; Path=/; Secure; SameSite=None; Partitioned` | 入罐（**分区键 `https://site-a.example`**） |
| 14 | 同上（顶层页 `https://site-b.example/`） | `ch=2; Path=/; Secure; SameSite=None; Partitioned` | 入罐（**另一分区，与第 13 条同名同域同路径并存**） |
| 15 | `https://widget.vendor.com/frame`（顶层页留空） | `ch=3; Path=/; Secure; Partitioned` | **拒绝**：Partitioned 缺少有效顶层页面 URL |
| 16 | `https://widget.vendor.com/frame`（顶层页 `https://site-a.example/`） | `ch=4; Path=/; Partitioned` | **拒绝**：Partitioned 未带 Secure |
| 17 | `https://widget.vendor.com/frame`（顶层页 `https://site-a.example/`） | `ch=; Path=/; Secure; Partitioned; Max-Age=0` | **删除** site-a 分区的 ch；site-b 分区与普通项保留 |

容量压力演算（右栏 **🎚️ 容量压力模拟**，或 `POST /api/capacity`）：

- 先设置 `example.com` 域容量为 **2**，再连续入罐 3 条同 Path 的 cookie：
  第 3 条入罐后触发域级淘汰，**Low 先于 Medium 先于 High** 出局；
- 把其中一条的 `Max-Age=1` 设为已过期：下次超限时**先清过期项**，清完不超限就不再淘汰；
- 连续请求某条 cookie（同站 GET 命中它）刷新其最近访问时间，再制造超限：
  同优先级下**最久未访问**的先出局；
- 再设一个较小的**全局容量**（如 3），观察跨域入罐时「域级 → 全局」两级报告依次出现。

然后分别用以下请求 URL 观察差异：

- `https://api.shop.example.com/admin/orders/9` —— 域 + Path 匹配
- `http://shop.example.com/admin/dashboard` —— 明文 http，Secure 项被排除
- `https://shop.example.com/home` —— Path 不匹配的项被排除并给出原因

SameSite 演算示例（第 2 步的「顶层页面 URL / 方法 / 顶层导航」）：

- 请求 `https://example.com/`，顶层页留空 —— 同站，`strict`/`xs` 都发送
- 请求 `https://example.com/`，顶层页 `https://other.org/`，方法 GET，勾选顶层导航
  —— 跨站：`strict` 被排除；显式/默认 Lax 与 `xs`（None）放行
- 同上但方法 POST —— 显式 Lax 被排除；**默认 Lax**（如第 10 条的 `weird`）
  在创建 120 秒内仍放行（Lax+POST 宽限）
- 同上但取消勾选顶层导航 —— 模拟子资源请求，跨站时只剩 `xs`（None）发送

⏱ 演算时钟示例（右栏「⏱ 演算时钟」，或 `POST /api/clock/advance`）：

- 写入 `m=1; Path=/; Max-Age=60` 后**推进 30 秒**：剩余 30 秒、照常发送；
  再**推进 31 秒**：罐中该条标灰「已过期」、发送被排除并注明过期时间——
  **推进本身不删除条目**，再写入新 cookie 触发容量淘汰时才按既有规则清理；
- 写入一条**默认 Lax** cookie（不声明 SameSite），跨站顶层 POST 在创建 120 秒内放行；
  **推进 121 秒**后同一请求被排除，原因注明「120 秒宽限已过」；
- 配合容量上限：先写入 `Max-Age=10` 的条目，**推进 11 秒**后再入罐新条目触发超限，
  观察「先清理过期项」的淘汰报告；
- 非法推进（0、负数、小数、非数字）会被拒绝且**时钟与罐均不变**；
  点击 **重置** 后时钟回到启动时刻，可从零复现整条时间线。

Partitioned（CHIPS）演算示例（写入时填「顶层页面 URL」，发送时由顶层页面 URL 计算请求分区键）：

- 依次写入上表第 13、14 条（同名为 `ch`、同域同路径，分属 `site-a` / `site-b` 两个分区），
  再写一条不带 `Partitioned` 的 `ch=u` —— 罐中共存 **3 条**；
- 请求 `https://widget.vendor.com/`，顶层页 `https://site-b.example/` ——
  **仅 site-b 分区项与普通项发送**，site-a 分区项在排除明细中给出
  「条目分区键 … ≠ 请求分区键 …」；
- 顶层页换成 `https://site-c.example/` —— 两个分区项都排除，**只剩普通项 `ch=u`**；
- 顶层页留空 —— 请求分区键回退为请求站（`https://vendor.com`），分区项全部不匹配；
- IP 顶层页（如 `http://192.168.1.6/`）分区键用完整主机且 scheme 参与：
  换端口仍同分区，换 IP 或换 scheme 即跨分区。

---

## 📐 实现的演算规则

### 写入（处理 Set-Cookie）

- **Domain**
  - 不带 `Domain` 属性 → **host-only cookie**，只匹配原主机；
  - 带 `Domain` → 规范化（小写、去前导点），且必须是响应主机本身或其上级域，
    否则**拒绝入罐**；
  - 主机是 IP 地址时不做域/子域匹配（Domain 不一致即拒绝）。
- **Path**
  - 合法属性值必须以 `/` 开头，否则忽略属性；
  - **缺省（或非法）时取响应 URL 路径最后一个斜杠之前的目录**
   （`/admin/dashboard` → `/admin`；根路径 → `/`）。
- **Max-Age**
  - 正整数：相对有效期（秒），换算成绝对过期时间；
  - **`<= 0`（含 `0` 与负数）：删除同名 `(name, domain, path)` 项**，不存在则说明无可删除；
  - 非法值（非整数）：忽略并提示，按会话 cookie 处理。`Expires` 属性不参与本演算。
- **Secure**：记录该属性；在明文 `http` 响应中设置会给出提示，且之后绝不会经 http 发送。
- **SameSite**
  - 解析 `Strict` / `Lax` / `None`（**大小写不敏感**）；
  - **未声明或值非法 → 记为默认 Lax**（非法值会给出提示）；
  - **`SameSite=None` 未同时声明 `Secure` → 拒绝入罐**（现代浏览器的强制要求）。
- **Priority**（RFC 6265bis，仅参与容量淘汰，不影响发送）
  - 解析 `Low` / `Medium` / `High`（**大小写不敏感**）；
  - **缺省或非法值 → 按 Medium**（都会给出提示；缺省提示「按默认 Medium 参与容量淘汰」）。
- **Partitioned**（CHIPS，RFC 6265bis 独立分区 cookie；无值标志属性）
  - **入罐三个条件缺一不可**：声明了 `Partitioned`、**同时声明 `Secure`**、写入时提供的
    **顶层页面 URL 是有效的 http(s) 地址**；任一不满足都**拒绝入罐**（普通 cookie 不受影响，
    其顶层 URL 字段被忽略）；
  - **分区键 = 顶层页面 URL 的 scheme + 可注册域（eTLD+1）**；IP、localhost 等无可注册域的
    主机用**完整主机**（路径 / 端口 / 查询串不参与，scheme 参与，如
    `https://www.embed.example.net:8443/app` → `https://embed.example.net`）；
  - 分区键是**存储身份**的一部分：`(name, domain, path, partitionKey)` 才唯一确定一项，
    因此**普通项与不同分区的同名同域同路径项并存**；覆盖更新与 `Max-Age <= 0` 删除都
    **只影响对应分区**，不触及其他分区或普通项（删除不存在时明确说明「不影响其他分区」）；
  - 分区项与普通项一样计入**域级与全局容量**，参与同一条淘汰排序。
- **屏蔽第三方 Cookie**（可选模式，默认关闭；对应 `blockThirdParty` 参数）
  - 开启后**必须提供有效顶层页面 URL**（http(s)），否则拒绝；按既有站点规则
    （**scheme + 可注册域**，IP / localhost 按完整主机）判定响应站与顶层站是否跨站；
  - **跨站响应拒绝写入和删除普通 Cookie**（含 `Max-Age<=0` 的删除）：拒绝不改动罐内容，
    也**不触发容量淘汰**；同站响应不受影响；
  - **Partitioned 分区项不受此限**：跨站响应中仍按既有 Secure 与分区键规则正常
    入罐 / 覆盖 / 删除；
  - 拒绝结果在 `reason` 中说明策略原因（含响应站 / 顶层站对比）。
- **同名同域同路径（分区项还需同分区键）**再次写入 → 覆盖更新，**沿用首次创建序号**
  （保证排序稳定），并刷新该条目的最近访问时间；普通项与各分区项互不覆盖。
- **容量压力淘汰**（入罐通过以上全部校验后执行；未设置任何上限时完全不干预）
  - 可分别为每个**可注册域**（eTLD+1，tldts/PSL 判定；IP、localhost 按完整主机分桶）
    与**全局**设置条目数上限；
  - 入罐后**先域级（仅新条目所属可注册域）后全局**；修改容量设置则对全部已配上限立即执行；
  - 范围内条数超限时：**先清理过期项**，再按
    **Priority 低 → 高、最近访问早 → 晚、创建序号小 → 大**淘汰至回到上限；
  - **发送成功**的条目刷新最近访问时间，作为同级 Priority 的淘汰依据。

### 发送（处理请求 URL + SameSite / 分区上下文）

除请求 URL 外，演算还需要三个上下文参数（界面第 2 步）：

- **顶层页面 URL**：同时决定 same-site 基准站与 **Partitioned 请求分区键**；
  留空时视为与请求 URL 相同（同站、同分区）；
- **请求方法**：GET / POST / …（大小写不敏感）；
- **是否顶层导航**：地址栏/链接跳转属于顶层导航；子资源、iframe、fetch 不属于。

**站点（site）= scheme + 可注册域（eTLD+1）**，可注册域由公共后缀列表
（tldts 内置 PSL，含私有域段，如 `github.io`）判定；**IP 地址与 localhost
等无可注册域的主机按完整主机比较**（`localhost` ≠ `127.0.0.1`，端口不参与）。
请求站与顶层站一致即「同站」，否则「跨站」（`http://example.com` 与
`https://example.com` 因 scheme 不同也算跨站）。

逐条检查（顺序与 RFC 6265 一致）：

1. **过期检查**：已过期不发送（罐中保留并标灰显示）；
2. **分区检查（Partitioned / CHIPS）**：请求分区键由顶层页面 URL（缺省取请求 URL）按
   scheme + 可注册域计算；**分区项只在自身分区键与请求分区键完全相同时继续后续检查**，
   键不同直接排除并在明细给出两个键；普通（未分区）项不参与分区隔离，照常检查；
3. **屏蔽第三方 Cookie（可选，默认关闭）**：开启时**必须提供有效顶层页面 URL**（缺省
   回退请求 URL 的宽松行为不再适用，缺失即报错）；**跨站请求排除普通 Cookie**，
   被排除条目**不刷新最近访问时间**；分区键匹配的 Partitioned 项不受此限，
   继续走后续检查；排除明细逐项说明策略原因；
4. **Domain 匹配**：host-only 仅精确匹配原主机；Domain cookie 匹配该域及其子域；
5. **Path 匹配**：请求路径与 cookie-path 相等，或以其开头且边界字符是 `/`；
6. **Secure 检查**：Secure cookie 只在 `https:` 请求中发送（分区项同样受此约束）；
7. **SameSite 检查**（仅跨站时拦截）：
   - `Strict`：**仅同站发送**；
   - 显式 `Lax`：同站，或**跨站顶层导航的安全方法**（GET/HEAD/OPTIONS/TRACE）；
   - **默认 Lax**（未声明/非法值）：同上，另允许**创建不超过 120 秒的跨站顶层 POST**
     （对齐 Chrome 的 Lax+POST 缓解，按首次创建时间计算）；
   - `None`：跨站照常发送（入罐时已强制 Secure）。

通过检查的条目按：

> **Path 长度降序 → 首次创建顺序（#序号）升序**

排序后以 `; ` 拼接成 `Cookie` 请求头（RFC 6265 的 cookie 排序要求）。

### document.cookie 脚本演算（页面 JS 视角；`/api/script/read`、`/api/script/write`）

与网络接口并列、但规则不同的一条独立路径，模拟浏览器页面里的 JavaScript 读写
`document.cookie`。

**读取（`POST /api/script/read`）**入参为页面 URL、顶层页面 URL、第三方屏蔽开关：

1. 与请求头完全一致的既有筛选顺序逐项检查：
   **过期 → 分区（Partitioned 分区键）→ 第三方屏蔽 → Domain → Path → Secure**
   （开启第三方屏蔽时同样必须提供有效顶层页面 URL；分区键匹配的 Partitioned 项同样豁免）；
2. **最后再排除 HttpOnly**：HttpOnly cookie 对页面脚本的 `document.cookie` 不可见，
   无论它是否通过前面的全部检查；
3. **不应用 SameSite**：脚本运行在已加载的文档内，读取 `document.cookie` 不受
   Strict / Lax / None 限制（跨站与否只通过可选的第三方屏蔽开关体现）；
4. **纯只读**：不刷新任何条目的最近访问时间，也不改动罐内容（用容量 LRA 淘汰可验证）；
5. 可读项**沿用请求头排序**（Path 长度降序、创建序号升序），以 `; ` 拼成
   `document.cookie` 读取字符串；不可读项在 `excluded` 中逐项给出具体原因。

**写入（`POST /api/script/write`）**复用 `/api/store` 的全部既有逻辑（同一套 Set-Cookie
解析、Domain / Path / Secure / SameSite=None 校验、Partitioned 分区身份、第三方屏蔽与
域级 / 全局容量淘汰），额外追加两条脚本专属约束：

- **拒绝带 `HttpOnly` 属性的赋值**：HttpOnly cookie 只能由网络响应的 `Set-Cookie` 写入；
- **拒绝覆盖、或以 `Max-Age<=0` 删除「同身份（name、domain、path、分区键相同）且未过期」
  的 HttpOnly 项**；已过期的 HttpOnly 项不在保护之列（脚本赋值可正常顶替 / 删除）。

两条脚本专属拒绝都发生在任何罐改动**之前**，因此**罐内容、全部时间戳（createdAt /
updatedAt / lastAccessedAt）与容量状态保持不变**，也不触发容量淘汰。

**网络接口不受影响**：`/api/store` 仍可写入、覆盖、删除 HttpOnly 项，`/api/send`
仍会在请求头中发送通过筛选的 HttpOnly 项——HttpOnly 只隔离页面脚本，不隔离网络栈。

### 演算时钟（可控时间轴；`/api/clock`、`/api/clock/advance`）

- **启动即固定**：服务启动时把当前真实时间固定为演算时钟起点，之后时钟**不随真实
  时间流动**，只经 `POST /api/clock/advance` 按**正整数秒**推进（数字或数字字符串均可）；
- **非法输入不变更任何状态**：缺省、0、负数、非整数、非数字的推进请求返回 400，
  **时钟与罐均保持不变**；
- **全链路统一时钟**：网络写入/发送、`document.cookie` 读写、罐快照（`GET /api/jar`）
  与容量淘汰都使用该时钟——`Max-Age` 过期判定、默认 Lax 的 **120 秒跨站顶层 POST
  宽限**（按创建时间计算）、容量淘汰前的**过期清理**、最近访问时间（LRA）均可逐秒
  步进复现；
- **推进本身不删除条目**：过期项仍留在罐中（界面标灰展示），下次发送/脚本读取匹配
  或容量淘汰时再按既有规则排除或清理；
- **重置同步复位**：`POST /api/reset` 清空罐的同时把时钟拨回启动时刻（容量设置仍保留），
  便于从零复现整条时间线。

### 场景快照（场景保存与恢复；`/api/snapshot`、`/api/snapshot/import`）

- **快照内容**：`GET /api/snapshot` 返回（响应的 `snapshot` 字段）一份 JSON 对象：
  - `format`：固定 `"cookie-jar-lab-snapshot"`（防止误传其它 JSON）；
  - `version`：快照版本号（当前为 `1`，导入仅接受当前版本）；
  - `exportedAt` / `exportedAtReadable`：导出时的真实墙钟时间（仅元信息）；
  - `cookies`：全部 **StoredCookie 原始条目**（非展示视图）——value、domain、path、
    hostOnly、secure、httpOnly、sameSite / sameSiteDefault、priority / priorityDefault、
    **partitioned / partitionKey**、expiresAt、**creationIndex**、**createdAt /
    updatedAt / lastAccessedAt** 等，**过期项同样包含**；
  - `nextIndex`：**下一创建序号**（恢复后新条目从它继续，保证排序稳定）；
  - `capacity`：`globalLimit`（`null` = 不限）与 `domainLimits`
    （`[{ domain, limit }]`）；
  - `clock`：`startedAt`（演算起点）与 `now`（当前值），毫秒整数时间戳。
- **导入完整校验**（`POST /api/snapshot/import`，body 为快照对象本身或
  `{ "snapshot": {...} }` 包裹均可；非法 JSON / 体积超 2MB 也返回 400）：
  - **结构**：顶层为对象，`format` 与 `version` 匹配，各字段类型正确；
  - **时间范围**：`clock.now ≥ clock.startedAt` 且二者之差为整秒数（时钟只能按正整数秒
    推进）；每条的 createdAt / updatedAt / lastAccessedAt 都落在 `[startedAt, now]` 内，
    expiresAt 省略或为非负整数毫秒时间戳（省略/null = 会话 cookie）；
  - **条目身份唯一性**：`(name, domain, path, partitionKey)` 不得重复，创建序号也不得重复；
  - **序号一致性**：创建序号为 ≥1 的整数且**严格小于** `nextIndex`；
  - 枚举/布尔字段合法（sameSite ∈ strict/lax/none、priority ∈ low/medium/high）；
    `SameSite=None` 必须 `secure=true`；`partitioned=true` 必须带非空 `partitionKey`，
    未分区必须为 `null`；容量上限为 `null` 或 ≥1 的整数。
- **原子替换**：全部校验通过后才一次性替换罐内容、容量规则（含时钟起点 `startedAt`）
  与当前时钟；**任一校验失败返回 400，旧罐、容量和时钟均不变**。
- **恢复语义**：恢复是精确状态替换，**不执行容量淘汰**，**过期项原样保留**；
  因此恢复后继续演算的结果与「导出后在原场景继续操作」完全一致：
  - **发送排序**：Path 长度降序、创建序号升序（创建序号原样恢复）；
  - **默认 Lax 宽限**：120 秒跨站顶层 POST 宽限按**首次创建时间** `createdAt` 计算；
  - **容量淘汰**：Priority → 最近访问时间 `lastAccessedAt` → 创建序号，与导出前连续；
  - 新写入条目从快照的 `nextIndex` 继续编号。

---

## 🔌 HTTP API

| 方法 | 路径 | Body（JSON） | 说明 |
|------|------|--------------|------|
| GET | `/api/jar` | — | 当前罐快照（`cookies` + `capacity`：容量设置与各可注册域用量 + `clock`：演算时钟） |
| GET | `/api/clock` | — | 读取演算时钟：`now`/`readable`（当前演算时间）、`startedAt`/`startedAtReadable`（启动时刻）、`elapsedSeconds`（已推进秒数） |
| POST | `/api/clock/advance` | `{ "seconds": 120 }` | 以**正整数秒**推进演算时钟（数字或数字字符串均可）；非法输入（缺省、0、负数、非整数、非数字）返回 400 且**时钟与罐均不变**。推进本身不删除条目，响应附最新 `clock`、`cookies` 与 `capacity`（过期/剩余展示随新时间刷新） |
| POST | `/api/store` | `{ "url": "...", "setCookie": "...", "topUrl"?: "...", "blockThirdParty"?: false }` | 顺序写入一条 Set-Cookie；`topUrl` 为顶层页面 URL，仅 `Partitioned` cookie 必需（计算分区键），普通 cookie 可省略。`blockThirdParty=true` 开启屏蔽第三方 Cookie：此时 `topUrl` 必填且须有效，跨站响应拒绝写入/删除普通 Cookie（不改动罐、不触发容量淘汰），Partitioned 分区项不受影响。响应含 `eviction`（本次触发的域级/全局淘汰清单与排序依据，无限额时为 `null`） |
| POST | `/api/send` | `{ "url": "...", "topUrl"?: "...", "method"?: "GET", "topLevelNav"?: true, "blockThirdParty"?: false }` | 演算 Cookie 头与逐项原因；请求分区键由顶层页面 URL（缺省取请求 URL）计算并以 `partitionKey` 返回，仅键相同的 `Partitioned` 项发送。`blockThirdParty=true` 时 `topUrl` 必填且须有效，跨站请求排除普通 Cookie（不刷新其最近访问时间），分区键匹配的 Partitioned 项仍可发送；响应以 `blockThirdParty` 回显开关状态。**HttpOnly 项照常发送**。发送成功的条目刷新最近访问时间，响应附最新 `cookies` 与 `capacity` |
| POST | `/api/script/read` | `{ "url": "...", "topUrl"?: "...", "blockThirdParty"?: false }` | **document.cookie 读取演算（页面 JS 视角）**：按既有 过期/分区/第三方屏蔽/Domain/Path/Secure 顺序筛选，**最后再排除 HttpOnly**；**不应用 SameSite、不刷新最近访问时间、不改动罐**。可读项沿用请求头排序（Path 长度降序、创建序号升序），以 `cookieString`（`; ` 拼接）返回，并在 `readable` / `excluded` 中逐项说明原因；上下文字段同 `/api/send`（页面站、顶层站、`partitionKey`、开关回显） |
| POST | `/api/script/write` | `{ "url": "...", "setCookie": "...", "topUrl"?: "...", "blockThirdParty"?: false }` | **document.cookie 赋值演算**：复用 `/api/store` 的解析、分区身份与容量逻辑，但**拒绝带 HttpOnly 的赋值**，并**拒绝覆盖或以 `Max-Age<=0` 删除同身份（name、domain、path、分区键）且未过期的 HttpOnly 项**（已过期的不在保护之列）；脚本专属拒绝在改动罐前返回，**罐内容、时间戳与容量不变**。响应结构同 `/api/store`（`action`/`reason`/`jar`/`eviction`） |
| POST | `/api/capacity` | `{ "globalLimit"?: number \| null, "domainLimits"?: { "example.com": 3 } }` | 替换式设置全局 / 每可注册域容量（正整数；`null`/缺省 = 不限），立即执行一轮淘汰并返回报告 |
| GET | `/api/snapshot` | — | 下载**场景快照**（`snapshot` 字段）：带 `format`/`version` 的 JSON，含全部原始 Cookie 条目（分区键、创建序号、创建/更新/最近访问时间，过期项也在）、容量规则、演算时钟起点与当前值、下一创建序号；响应另附 `cookieCount`、`clock`、`capacity` |
| POST | `/api/snapshot/import` | 快照对象本身，或 `{ "snapshot": {...} }` | **导入场景快照**：先完整校验结构 / 时间范围 / 条目身份唯一性 / 序号一致性 / 枚举约束（非法 JSON 或体积超 2MB 同样 400），通过后一次性替换罐、容量规则与时钟；失败返回 400 且**旧罐、容量和时钟均不变**。成功响应含 `restoredCount`、`domainLimitCount`、`globalLimit`、`clock`、`capacity`、`jar`（过期项保留）、`snapshot` |
| POST | `/api/reset` | — | 清空内存罐（**容量设置保留**；**演算时钟同步回到服务启动时刻**，响应附复位后的 `clock`） |

curl 示例：

```bash
# 写入（SameSite 大小写不敏感；SameSite=None 必须带 Secure）
curl -s -X POST http://localhost:3000/api/store \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example.com/admin/dashboard",
       "setCookie":"sid=abc; Domain=example.com; Path=/; Max-Age=3600; Secure; SameSite=Lax"}'

# 写入 Partitioned（CHIPS）：必须带 Secure，并提供顶层页面 URL 计算分区键
curl -s -X POST http://localhost:3000/api/store \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://widget.vendor.com/frame",
       "setCookie":"ch=1; Path=/; Secure; SameSite=None; Partitioned",
       "topUrl":"https://embed.example.net/"}'

# 演算请求（partitionKey 回显请求分区键；仅分区键相同的 Partitioned 项发送）
curl -s -X POST http://localhost:3000/api/send \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://widget.vendor.com/frame",
       "topUrl":"https://embed.example.net/page", "method":"GET", "topLevelNav":true}'

# 演算请求（跨站顶层导航 GET：Strict 被拦截，Lax/None 放行）
curl -s -X POST http://localhost:3000/api/send \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://api.shop.example.com/orders/123",
       "topUrl":"https://other.org/", "method":"GET", "topLevelNav":true}'

# 屏蔽第三方 Cookie：跨站响应的普通 Cookie 拒绝写入（Partitioned 分区项不受影响）
curl -s -X POST http://localhost:3000/api/store \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://tracker.vendor.com/pixel",
       "setCookie":"trk=1; Path=/",
       "topUrl":"https://shop.example.com/", "blockThirdParty":true}'

# 屏蔽第三方 Cookie：跨站请求排除普通 Cookie，分区键匹配的 Partitioned 项仍发送
curl -s -X POST http://localhost:3000/api/send \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://widget.vendor.com/frame",
       "topUrl":"https://embed.example.net/page", "blockThirdParty":true}'

# 设置容量：example.com 域 3 条、全局 10 条（立即按新上限执行一次淘汰）
curl -s -X POST http://localhost:3000/api/capacity \
  -H 'Content-Type: application/json' \
  -d '{"globalLimit":10,"domainLimits":{"example.com":3}}'

# 取消全部限制
curl -s -X POST http://localhost:3000/api/capacity \
  -H 'Content-Type: application/json' -d '{"globalLimit":null,"domainLimits":{}}'

# 重置（罐清空，容量设置保留，演算时钟回到启动时刻）
curl -s -X POST http://localhost:3000/api/reset

# 下载场景快照（带 format/version：原始条目 + 分区键 + 创建序号/访问时间 + 容量规则 + 时钟 + 下一序号）
curl -s http://localhost:3000/api/snapshot -o cookie-jar-snapshot.json

# 导入场景快照（body 直接是快照对象；校验失败返回 400，旧罐、容量和时钟均不变）
curl -s -X POST http://localhost:3000/api/snapshot/import \
  -H 'Content-Type: application/json' \
  --data @cookie-jar-snapshot.json

# 也支持 { "snapshot": {...} } 包裹形式
curl -s -X POST http://localhost:3000/api/snapshot/import \
  -H 'Content-Type: application/json' \
  -d "{\"snapshot\":$(cat cookie-jar-snapshot.json | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["snapshot"]))')}"

# 读取演算时钟（启动时固定，不随真实时间流动）
curl -s http://localhost:3000/api/clock

# 推进演算时钟 120 秒（正整数；Max-Age 过期、Lax+POST 120 秒宽限随之逐步复现）
curl -s -X POST http://localhost:3000/api/clock/advance \
  -H 'Content-Type: application/json' -d '{"seconds":120}'

# 非法推进（0 / 负数 / 非整数 / 非数字）-> 400，时钟与罐均不变
curl -s -X POST http://localhost:3000/api/clock/advance \
  -H 'Content-Type: application/json' -d '{"seconds":0}'

# document.cookie 读取：HttpOnly 项不在 cookieString 中（不应用 SameSite、不刷新访问时间）
curl -s -X POST http://localhost:3000/api/script/read \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example.com/admin/dashboard",
       "topUrl":"https://embed.example.net/page", "blockThirdParty":false}'

# document.cookie 读取 + 屏蔽第三方：跨站页面普通 Cookie 读不到，分区键匹配的 Partitioned 项仍可读
curl -s -X POST http://localhost:3000/api/script/read \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://widget.vendor.com/frame",
       "topUrl":"https://embed.example.net/page", "blockThirdParty":true}'

# document.cookie 赋值：普通 cookie 正常入罐（与 /api/store 同语法、同容量逻辑）
curl -s -X POST http://localhost:3000/api/script/write \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example.com/admin/dashboard",
       "setCookie":"uiTheme=dark; Path=/; Max-Age=3600"}'

# document.cookie 赋值带 HttpOnly -> 拒绝（罐内容、时间戳、容量均不变）
curl -s -X POST http://localhost:3000/api/script/write \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example.com/admin/dashboard",
       "setCookie":"evil=1; Path=/; HttpOnly"}'

# 覆盖 / Max-Age=0 删除同身份未过期 HttpOnly 项 -> 拒绝；网络接口 /api/store 不受此限
curl -s -X POST http://localhost:3000/api/script/write \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example.com/admin/dashboard","setCookie":"sid=hacked"}'
```

---

## 📁 项目结构

```
.
├── Dockerfile              # 多阶段构建：tsc 编译 → 精简运行镜像
├── docker-compose.yml      # 单条命令启动（3000:3000）
├── package.json
├── tsconfig.json
├── src
│   ├── server.ts           # Express 入口与 API（含容量设置、document.cookie 脚本读写、演算时钟读取/推进、场景快照下载/导入接口）
│   └── cookieJar.ts        # 全部 Cookie 演算规则（解析/入罐/匹配/排序/SameSite/Priority/Partitioned/容量淘汰/document.cookie 脚本视角/演算时钟/场景快照导出与完整校验导入）
└── public
    ├── index.html          # 原生前端页面（含顶层 URL 输入、容量压力配置、document.cookie 演算、演算时钟与场景快照下载/导入面板）
    ├── styles.css
    └── app.js
```

## 不用 Docker 的本地运行

需要 Node.js 18+（推荐 20）：

```bash
npm install
npm run build      # tsc 编译到 dist/
npm start          # 打开 http://localhost:3000
```

开发模式（免编译，自动 ts-node 直跑）：

```bash
npm run dev
```

> 说明：本工具是**演算/教学工具**，Cookie 仅存于服务端进程内存，刻意聚焦
> Domain / Path / Max-Age / Secure / SameSite / Priority / **Partitioned（CHIPS 分区）**
> 与容量压力淘汰等规则；
> **HttpOnly** 按浏览器真实语义在两条路径上区分：**网络接口**（`/api/store` 写入、
> `/api/send` 请求头）可正常写入 / 更新 / 删除 / 发送 HttpOnly 项（仅在罐表格中展示标签）；
> **页面脚本接口**（`/api/script/read`、`/api/script/write`）读取时一律排除 HttpOnly、
> 不应用 SameSite 且不刷新最近访问时间，写入时拒绝声明 HttpOnly、也拒绝覆盖或
> `Max-Age<=0` 删除同身份未过期的 HttpOnly 项（拒绝时罐内容、时间戳与容量不变）。
> 不处理 Expires、单条 cookie 字节大小上限等。
> 分区键与站点一致，取**顶层 URL 的 scheme + 可注册域**（IP、localhost 用完整主机）；
> **屏蔽第三方 Cookie** 为可选模式（默认关闭）：开启后跨站响应拒绝写入/删除普通
> Cookie、跨站请求排除普通 Cookie，Partitioned 分区项均不受此限。
> 容量按**条目条数**模拟（RFC 6265bis 的每可注册域 180 条、全局 3000 条同型机制）。
> **时间由演算时钟统一提供**：服务启动时固定当前真实时间，之后只经
> `POST /api/clock/advance` 按正整数秒推进（不随真实时间流动）；网络写入/发送、
> `document.cookie` 读写、罐快照与容量淘汰都取该时钟，推进本身不删除条目，
> 重置罐时时钟回到启动时刻；同一时间戳内的次序由创建序号兜底。
