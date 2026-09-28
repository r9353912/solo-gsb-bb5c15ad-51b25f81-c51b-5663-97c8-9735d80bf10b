#!/usr/bin/env bash
# 端到端规则验证脚本（依赖 curl + python3 做 JSON 断言）
set -u
BASE="http://localhost:3000"
PASS=0; FAIL=0

check() { # desc  expected_substr  actual
  if [[ "$3" == *"$2"* ]]; then echo "✅ $1"; PASS=$((PASS+1));
  else echo "❌ $1"; echo "   期望包含: $2"; echo "   实际: $3"; FAIL=$((FAIL+1)); fi
}

post() { curl -s -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }
# 推进演算时钟（服务启动时时钟固定，不随真实时间流动，只能按正整数秒推进）
adv() { post /api/clock/advance "{\"seconds\":$1}" >/dev/null; }

post /api/reset '{}' >/dev/null

echo "== 1. host-only cookie，默认 Path（/admin/dashboard -> /admin） =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard?tab=1","setCookie":"tracker=xyz; Max-Age=3600"}')
check "入罐成功" '"action":"stored"' "$R"
check "host-only 作用域" "host-only" "$R"
check "默认 Path=/admin 提示" "默认路径" "$R"

echo "== 2. Domain cookie，显式 Path=/ =="
R=$(post /api/store '{"url":"https://example.com/","setCookie":"prefs=dark; Domain=example.com; Path=/; Max-Age=100"}')
check "Domain 入罐" '"action":"stored"' "$R"
check "domain 作用域" "domain" "$R"

echo "== 3. Domain 不匹配响应主机 -> 拒绝 =="
R=$(post /api/store '{"url":"http://evil.example.org/","setCookie":"bad=nope; Domain=example.com"}')
check "拒绝状态" '"action":"rejected"' "$R"
check "拒绝原因（不匹配响应主机）" "不匹配响应主机" "$R"

echo "== 4. 上级子域写法合法（host=a.b.example.com, Domain=b.example.com） =="
R=$(post /api/store '{"url":"https://a.b.example.com/x/y","setCookie":"z=1; Domain=b.example.com"}')
check "上级域入罐" '"action":"stored"' "$R"
check "默认 Path=/x" 'Path=/x' "$R"

echo "== 5. 非法 Path（相对路径）忽略，取默认路径 =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard","setCookie":"rel=v; Path=admin; Max-Age=99"}')
check "入罐" '"action":"stored"' "$R"
check "Path 提示" "不是绝对路径" "$R"

echo "== 6. http 响应写 Secure 给提示但仍记录 =="
R=$(post /api/store '{"url":"http://shop.example.com/","setCookie":"sec=1; Path=/; Secure"}')
check "入罐（带提示）" '"action":"stored"' "$R"
check "Secure 提示" "明文 http" "$R"

echo "== 7. IP 主机 + 不匹配 Domain -> 拒绝 =="
R=$(post /api/store '{"url":"http://192.168.1.10/","setCookie":"ipbad=1; Domain=example.com"}')
check "IP 拒绝" '"action":"rejected"' "$R"

echo "== 8. 同名同域同路径覆盖，沿用创建序号 =="
R=$(post /api/store '{"url":"https://example.com/","setCookie":"prefs=light; Domain=example.com; Path=/; Max-Age=200"}')
check "更新动作" '"action":"updated"' "$R"
check "值被覆盖" 'prefs' "$R"

echo "== 9. Max-Age<=0 删除同名项 =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard","setCookie":"tracker=gone; Max-Age=0"}')
check "删除动作" '"action":"deleted"' "$R"
check "删除原因" "已删除" "$R"

echo "== 10. 负 Max-Age 删不存在的项 =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard","setCookie":"ghost=x; Max-Age=-5"}')
check "删除动作（无目标）" '"action":"deleted"' "$R"
check "无可删除" "无可删除" "$R"

echo "== 11. 缺 name= 解析失败 =="
R=$(post /api/store '{"url":"https://example.com/","setCookie":"notacookie"}')
check "拒绝" '"action":"rejected"' "$R"
check "解析失败原因" "解析失败" "$R"

echo "== 12. 非法 URL =="
R=$(post /api/store '{"url":"not-a-url","setCookie":"a=b"}')
check "拒绝" '"action":"rejected"' "$R"

echo
echo "------- 请求演算 -------"

echo "== A. https 子域请求，Domain cookie + Path 命中 =="
R=$(post /api/send '{"url":"https://api.shop.example.com/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "prefs 发送" "prefs=light" "$HDR"
# sec 是 shop.example.com 的 host-only cookie，api 子域不应收到
if [[ "$HDR" != *"sec=1"* ]]; then echo "✅ host-only sec 不发往 api 子域"; PASS=$((PASS+1));
else echo "❌ host-only cookie 被错误发给子域"; FAIL=$((FAIL+1)); fi

echo "== B. http 请求：Secure 项被排除 =="
R=$(post /api/send '{"url":"http://shop.example.com/"}')
check "Secure 排除原因" "仅经 https 发送" "$R"
check "host-only prefs? prefs 是 domain example.com -> 子域 shop 可发，但 http 不影响非 Secure" "prefs=light" "$R"

echo "== C. Path 不匹配（/home 不命中 /admin） =="
R=$(post /api/send '{"url":"https://shop.example.com/home"}')
check "Path 排除原因" "Path 不匹配" "$R"

echo "== D. Path 边界规则：/adminxxx 不命中 /admin；/admin/x 命中 =="
R=$(post /api/send '{"url":"https://shop.example.com/adminxxx"}')
check "/adminxxx 不命中" "Path 不匹配" "$R"
R=$(post /api/send '{"url":"https://shop.example.com/admin/users"}')
if [[ "$R" != *"Path 不匹配"* ]]; then echo "✅ /admin/users 命中 cookie-path=/admin"; PASS=$((PASS+1));
else echo "❌ /admin/users 应命中 /admin"; FAIL=$((FAIL+1)); fi

echo "== E. host-only 仅匹配原主机（tracker 已删；z 是 domain=b.example.com） =="
R=$(post /api/send '{"url":"https://other.example.com/"}')
check "prefs(domain) 仍发" "prefs=light" "$R"
R=$(post /api/send '{"url":"https://b.example.com/x/"}')
check "z 发往 b.example.com 本身" "z=1" "$R"
R=$(post /api/send '{"url":"https://c.b.example.com/x/deep"}')
check "z 发往子域 c.b.example.com" "z=1" "$R"
R=$(post /api/send '{"url":"https://notb.example.com/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"z=1"* ]]; then echo "✅ z 不发往无关域（$HDR）"; PASS=$((PASS+1));
else echo "❌ z 不应发往 notb.example.com"; FAIL=$((FAIL+1)); fi

echo "== F. 排序：Path 长度降序 =="
post /api/store '{"url":"https://sorted.test/a/b/c","setCookie":"long=1; Path=/a/b"}' >/dev/null
post /api/store '{"url":"https://sorted.test/","setCookie":"root=2; Path=/"}' >/dev/null
post /api/store '{"url":"https://sorted.test/","setCookie":"short=3; Path=/a"}' >/dev/null
R=$(post /api/send '{"url":"https://sorted.test/a/b/c/page"}')
LONG_AT=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);h=d['cookieHeader'];print(h.find('long=1'))")
SHORT_AT=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);h=d['cookieHeader'];print(h.find('short=3'))")
ROOT_AT=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);h=d['cookieHeader'];print(h.find('root=2'))")
if [ "$LONG_AT" -lt "$SHORT_AT" ] && [ "$SHORT_AT" -lt "$ROOT_AT" ]; then
  echo "✅ 排序正确: $(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")"; PASS=$((PASS+1))
else echo "❌ 排序错误 long=$LONG_AT short=$SHORT_AT root=$ROOT_AT"; FAIL=$((FAIL+1)); fi

echo "== G. 同 Path 长度按创建顺序升序 =="
post /api/store '{"url":"https://order.test/aa","setCookie":"c1=1; Path=/aa"}' >/dev/null
post /api/store '{"url":"https://order.test/aa","setCookie":"c2=2; Path=/aa"}' >/dev/null
R=$(post /api/send '{"url":"https://order.test/aa/x"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "c1 在 c2 前" "c1=1; c2=2" "$HDR"

echo "== H. 过期 cookie 不发送（Max-Age=1 秒，推进 2 秒过期） =="
post /api/store '{"url":"https://exp.test/","setCookie":"quick=dying; Path=/; Max-Age=1"}' >/dev/null
adv 2
R=$(post /api/send '{"url":"https://exp.test/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"quick=dying"* ]]; then echo "✅ 过期项不在 Cookie 头"; PASS=$((PASS+1));
else echo "❌ 过期项仍被发送"; FAIL=$((FAIL+1)); fi
check "排除原因标注已过期" "已过期" "$R"

echo "== I. GET /api/jar 与重置 =="
J=$(curl -s "$BASE/api/jar")
check "jar 接口 ok" '"ok":true' "$J"
R=$(post /api/reset '{}')
check "重置 ok" '"ok":true' "$R"
J=$(curl -s "$BASE/api/jar")
check "重置后为空" '"cookies":[]' "$J"

echo
echo "------- SameSite 写入演算 -------"

echo "== J1. SameSite 大小写不敏感（STRICT） =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_strict=1; Path=/; SameSite=STRICT"}')
check "入罐" '"action":"stored"' "$R"
check "解析为 strict" '"sameSite":"strict"' "$R"

echo "== J2. 非法 SameSite 值 -> 默认 Lax + 提示 =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_def=1; Path=/; SameSite=Banana"}')
check "入罐" '"action":"stored"' "$R"
check "记为 lax" '"sameSite":"lax"' "$R"
check "标记为默认" '"sameSiteDefault":true' "$R"
check "非法值提示" "SameSite 值非法" "$R"

echo "== J3. 未声明 SameSite -> 默认 Lax =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_plain=1; Path=/"}')
check "默认 lax" '"sameSite":"lax"' "$R"
check "标记为默认" '"sameSiteDefault":true' "$R"

echo "== J4. SameSite=None 未带 Secure -> 拒绝入罐 =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_none_bad=1; SameSite=None"}')
check "拒绝" '"action":"rejected"' "$R"
check "拒绝原因" "SameSite=None 必须同时声明 Secure" "$R"

echo "== J5. SameSite=None + Secure（混合大小写） -> 入罐 =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_none=1; Path=/; Secure; SameSite=nOnE"}')
check "入罐" '"action":"stored"' "$R"
check "解析为 none" '"sameSite":"none"' "$R"

echo "== J6. 显式 Lax（非默认） =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_lax=1; Path=/; SameSite=Lax"}')
check "解析为 lax" '"sameSite":"lax"' "$R"
check "非默认" '"sameSiteDefault":false' "$R"

echo "== J7. Domain cookie + Strict（供子域同站测试） =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_dom=1; Domain=ss.test; Path=/; SameSite=Strict"}')
check "入罐" '"action":"stored"' "$R"

echo
echo "------- SameSite 发送演算 -------"

echo "== K1. 同站上下文（缺省 topUrl=请求 URL）全部放行 =="
R=$(post /api/send '{"url":"https://ss.test/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "Strict 同站发送" "ss_strict=1" "$HDR"
check "None 同站发送" "ss_none=1" "$HDR"
check "同站标记" '"sameSiteContext":true' "$R"

echo "== K2. 跨站顶层 GET：Strict 排除，Lax/None 放行 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"https://other.org/","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "跨站标记" '"sameSiteContext":false' "$R"
check "显式 Lax 跨站顶层 GET 放行" "ss_lax=1" "$HDR"
check "默认 Lax 跨站顶层 GET 放行" "ss_def=1" "$HDR"
check "None 跨站放行" "ss_none=1" "$HDR"
if [[ "$HDR" != *"ss_strict=1"* ]]; then echo "✅ Strict 跨站不发送"; PASS=$((PASS+1));
else echo "❌ Strict 跨站被误发"; FAIL=$((FAIL+1)); fi
check "Strict 排除原因" "SameSite=Strict：仅同站请求发送" "$R"

echo "== K3. 跨站顶层 POST：默认 Lax 120 秒宽限放行，显式 Lax 排除 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"https://other.org/","method":"POST","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "默认 Lax 宽限内放行" "ss_def=1" "$HDR"
check "宽限说明" "120 秒宽限的顶层 POST" "$R"
if [[ "$HDR" != *"ss_lax=1"* ]]; then echo "✅ 显式 Lax 跨站 POST 不享受宽限"; PASS=$((PASS+1));
else echo "❌ 显式 Lax 跨站 POST 被误发"; FAIL=$((FAIL+1)); fi
check "显式 Lax 排除原因" "跨站顶层导航仅安全方法" "$R"

echo "== K3b. 推进 121 秒后：默认 Lax 跨站顶层 POST 的 120 秒宽限过期 =="
adv 121
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"https://other.org/","method":"POST","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"ss_def=1"* ]]; then echo "✅ 宽限过期后默认 Lax 跨站 POST 不再放行"; PASS=$((PASS+1));
else echo "❌ 宽限过期后默认 Lax 仍被放行（$HDR）"; FAIL=$((FAIL+1)); fi
check "宽限已过原因" "120 秒宽限已过" "$R"

echo "== K4. 跨站非顶层导航 GET：仅 None 放行 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"https://other.org/","method":"GET","topLevelNav":false}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "None 仍放行" "ss_none=1" "$HDR"
if [[ "$HDR" != *"ss_lax=1"* ]] && [[ "$HDR" != *"ss_def=1"* ]]; then echo "✅ Lax 非顶层导航不发送"; PASS=$((PASS+1));
else echo "❌ Lax 非顶层导航被误发（$HDR）"; FAIL=$((FAIL+1)); fi
check "非顶层导航排除原因" "非顶层导航" "$R"

echo "== K5. 子域同站：api.ss.test 请求 + ss.test 顶层页 =="
R=$(post /api/send '{"url":"https://api.ss.test/","topUrl":"https://ss.test/","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "同站标记（eTLD+1 相同）" '"sameSiteContext":true' "$R"
check "Strict Domain cookie 同站发送" "ss_dom=1" "$HDR"
R=$(post /api/send '{"url":"https://api.ss.test/","topUrl":"https://other.org/","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"ss_dom=1"* ]]; then echo "✅ Strict Domain cookie 跨站不发"; PASS=$((PASS+1));
else echo "❌ Strict Domain cookie 跨站误发"; FAIL=$((FAIL+1)); fi

echo "== K6. schemeful：http 与 https 不同站 =="
post /api/store '{"url":"http://plain.test/","setCookie":"sch=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"http://plain.test/","topUrl":"https://plain.test/"}')
check "scheme 不同即跨站" '"sameSiteContext":false' "$R"
R=$(post /api/send '{"url":"http://plain.test/","topUrl":"http://plain.test/"}')
check "scheme 相同同站" '"sameSiteContext":true' "$R"
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "Strict 同站发送" "sch=1" "$HDR"

echo "== K7. localhost / IP 按完整主机比较 =="
post /api/store '{"url":"http://localhost/","setCookie":"lo=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"http://localhost/","topUrl":"http://127.0.0.1/"}')
check "localhost ≠ 127.0.0.1" '"sameSiteContext":false' "$R"
R=$(post /api/send '{"url":"http://localhost/","topUrl":"http://localhost:8080/"}')
check "localhost 不同端口仍同站" '"sameSiteContext":true' "$R"
post /api/store '{"url":"http://192.168.1.10/","setCookie":"ipc=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"http://192.168.1.10/","topUrl":"http://192.168.1.11/"}')
check "不同 IP 不同站" '"sameSiteContext":false' "$R"
R=$(post /api/send '{"url":"http://192.168.1.10/","topUrl":"http://192.168.1.10/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "同 IP 同站发送" "ipc=1" "$HDR"

echo "== K8. 公共后缀：example.co.uk 整域才是可注册域 =="
post /api/store '{"url":"https://shop.example.co.uk/","setCookie":"uk=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"https://shop.example.co.uk/","topUrl":"https://example.co.uk/"}')
check "同 eTLD+1 同站" '"sameSiteContext":true' "$R"
R=$(post /api/send '{"url":"https://shop.example.co.uk/","topUrl":"https://other.co.uk/"}')
check "co.uk 下不同注册域跨站" '"sameSiteContext":false' "$R"

echo "== K9. 顶层页面 URL 非法 -> 报错 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"not-a-url"}')
check "非法顶层 URL" "顶层页面 URL 非法" "$R"

post /api/reset '{}' >/dev/null

echo
echo "------- Priority 与容量压力模拟 -------"

echo "== P1. Priority 缺省 -> Medium（默认）+ 提示 =="
R=$(post /api/store '{"url":"https://cap.test/","setCookie":"p_def=1; Path=/"}')
check "入罐" '"action":"stored"' "$R"
check "priority=medium" '"priority":"medium"' "$R"
check "标记默认" '"priorityDefault":true' "$R"
check "缺省提示" "Priority 属性缺省" "$R"
check "标签 Medium（默认）" "Medium（默认）" "$R"
check "最近访问字段" '"lastAccessedAt"' "$R"

echo "== P2. Priority 非法 -> Medium（默认）+ 非法提示 =="
R=$(post /api/store '{"url":"https://cap.test/","setCookie":"p_bad=1; Path=/; Priority=Ultra"}')
check "入罐" '"action":"stored"' "$R"
check "按 medium" '"priority":"medium"' "$R"
check "非法提示" "Priority 值非法" "$R"

echo "== P3. Low / High 大小写不敏感 =="
R=$(post /api/store '{"url":"https://cap.test/","setCookie":"p_low=1; Path=/; Priority=low"}')
check "low" '"priority":"low"' "$R"
R=$(post /api/store '{"url":"https://cap.test/","setCookie":"p_high=1; Path=/; Priority=HIGH"}')
check "high" '"priority":"high"' "$R"

post /api/reset '{}' >/dev/null

echo "== P4. 无容量限制时 eviction 为 null =="
R=$(post /api/store '{"url":"https://cap.test/","setCookie":"x=1; Path=/"}')
check "eviction=null" '"eviction":null' "$R"

echo "== P5. 设置域级容量（cap.test=2） =="
R=$(post /api/capacity '{"domainLimits":{"cap.test":2}}')
check "capacity ok" '"ok":true' "$R"
check "未超限不触发" '"triggered":false' "$R"
J=$(curl -s "$BASE/api/jar")
check "快照含上限" '"domain":"cap.test","limit":2' "$J"

echo "== P6. 第 3 条入罐：超限时先淘汰 Low =="
post /api/store '{"url":"https://cap.test/","setCookie":"m=1; Path=/; Priority=Medium"}' >/dev/null
post /api/store '{"url":"https://cap.test/","setCookie":"h=1; Path=/; Priority=High"}' >/dev/null
R=$(post /api/store '{"url":"https://cap.test/","setCookie":"l=1; Path=/; Priority=Low"}')
check "触发淘汰" '"triggered":true' "$R"
check "域级阶段" '"scope":"domain"' "$R"
check "淘汰 Low 项" '"cookie":"l=1"' "$R"
check "淘汰原因含排序依据" "优先级从低到高" "$R"
check "淘汰原因含最近访问" "最近访问" "$R"
check "淘汰原因含创建序号" "创建序号" "$R"
HDR=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);print(','.join(sorted(c['name'] for c in d['jar'])))")
check "剩 h,m" "h,m" "$HDR"

echo "== P7. 子域共用可注册域桶（sub.cap.test 计入 cap.test） =="
R=$(post /api/store '{"url":"https://sub.cap.test/","setCookie":"sub=1; Path=/; Priority=High"}')
check "域级再淘汰" '"scope":"domain"' "$R"
check "Medium 先于 High 出局" '"cookie":"m=1"' "$R"
J=$(curl -s "$BASE/api/jar")
echo "$J" | python3 -c "
import sys,json
d=json.load(sys.stdin)
names=sorted(c['name'] for c in d['cookies'])
assert names==['h','sub'], names
u=[x for x in d['capacity']['usage'] if x['domain']=='cap.test'][0]
assert (u['count'],u['limit'])==(2,2), u
print('✅ 子域同桶且用量 2/2')" && PASS=$((PASS+1)) || { echo "❌ 子域桶/用量错误"; FAIL=$((FAIL+1)); }

echo "== P8. 另一可注册域不受 cap.test 上限影响 =="
R=$(post /api/store '{"url":"https://other.site/","setCookie":"o=1; Path=/"}')
if [[ "$R" == *'"triggered":true'* ]]; then echo "❌ 无关域被淘汰"; FAIL=$((FAIL+1));
else echo "✅ 无关域不触发淘汰"; PASS=$((PASS+1)); fi

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== P9. 超限时先清理过期项，清完不超限则不淘汰 =="
post /api/capacity '{"domainLimits":{"exp.cap":2}}' >/dev/null
post /api/store '{"url":"https://a.exp.cap/","setCookie":"dead=1; Path=/; Max-Age=1; Priority=High"}' >/dev/null
post /api/store '{"url":"https://a.exp.cap/","setCookie":"lowc=1; Path=/; Priority=Low"}' >/dev/null
adv 2
R=$(post /api/store '{"url":"https://a.exp.cap/","setCookie":"medc=1; Path=/; Priority=Medium"}')
check "过期清理 1 条" '"expiredRemoved":1' "$R"
check "无需优先级淘汰" '"evictedCount":0' "$R"
check "清单标过期清理" '"reason":"expired"' "$R"
check "Low 项存活" '"name":"lowc"' "$R"

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== P10. 全局容量淘汰（跨域总条数） =="
post /api/capacity '{"globalLimit":3}' >/dev/null
post /api/store '{"url":"https://g1.test/","setCookie":"a=1; Path=/; Priority=Medium"}' >/dev/null
post /api/store '{"url":"https://g2.test/","setCookie":"b=1; Path=/; Priority=High"}' >/dev/null
post /api/store '{"url":"https://g3.test/","setCookie":"c=1; Path=/; Priority=Medium"}' >/dev/null
R=$(post /api/store '{"url":"https://g4.test/","setCookie":"d=1; Path=/; Priority=Low"}')
check "全局阶段" '"scope":"global"' "$R"
check "Low 出局" '"cookie":"d=1"' "$R"
check "上限 3" '"limit":3' "$R"
J=$(curl -s "$BASE/api/jar")
check "全局用量 3/3" '"totalCount":3' "$J"

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== P11. 域级先于全局：同次入罐两级分别出报告 =="
post /api/capacity '{"globalLimit":3,"domainLimits":{"two.test":1}}' >/dev/null
post /api/store '{"url":"https://two.test/","setCookie":"t1=1; Path=/; Priority=High"}' >/dev/null
post /api/store '{"url":"https://u1.test/","setCookie":"u1=1; Path=/; Priority=Medium"}' >/dev/null
post /api/store '{"url":"https://u2.test/","setCookie":"u2=1; Path=/; Priority=Low"}' >/dev/null
R=$(post /api/store '{"url":"https://two.test/","setCookie":"t2=2; Path=/; Priority=Medium"}')
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
stages=d['eviction']['stages']
assert len(stages)==2, stages
ds, gs = stages
assert ds['scope']=='domain' and gs['scope']=='global', stages
# 域级：t2(Medium) 比 t1(High) 先出局（新来者同样可被淘汰）
assert ds['triggered'] and ds['removed'][0]['cookie']=='t2=1' or ds['removed'][0]['cookie']=='t2=2', ds
assert ds['removed'][0]['cookie']=='t2=2', ds
# 域级淘汰后总数仍为 3，全局阶段执行但未超限
assert not gs['triggered'] and gs['beforeCount']==3, gs
print('✅ 域级先触发（Medium 的 t2 先于 High 的 t1 出局），全局阶段随后执行但未超限')" && PASS=$((PASS+1)) || { echo "❌ 两级顺序错误"; FAIL=$((FAIL+1)); }

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== P12. LRA：发送成功刷新最近访问时间，最久未访问先淘汰（同优先级）=="
post /api/capacity '{"domainLimits":{"lra.test":2}}' >/dev/null
post /api/store '{"url":"https://lra.test/keep","setCookie":"c1=1; Path=/keep; Priority=Medium"}' >/dev/null
adv 1
post /api/store '{"url":"https://lra.test/other","setCookie":"c2=2; Path=/other; Priority=Medium"}' >/dev/null
adv 1
# 仅请求 /keep：只发送 c1，c1 的最近访问时间被刷新
post /api/send '{"url":"https://lra.test/keep/x"}' >/dev/null
adv 1
R=$(post /api/store '{"url":"https://lra.test/z","setCookie":"c3=3; Path=/z; Priority=Medium"}')
check "淘汰最久未访问的 c2" '"cookie":"c2=2"' "$R"

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== P13. 修改容量立即执行一次淘汰 =="
post /api/store '{"url":"https://imm.test/","setCookie":"hi=1; Path=/; Priority=High"}' >/dev/null
post /api/store '{"url":"https://imm.test/","setCookie":"me=1; Path=/; Priority=Medium"}' >/dev/null
post /api/store '{"url":"https://imm.test/","setCookie":"lo=1; Path=/; Priority=Low"}' >/dev/null
R=$(post /api/capacity '{"globalLimit":2}')
check "立即淘汰" '"cookie":"lo=1"' "$R"
check "返回最新罐" '"name":"hi"' "$R"

echo "== P14. 容量参数校验 =="
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/capacity" -H 'Content-Type: application/json' -d '{"globalLimit":0}')
[ "$R" = "400" ] && { echo "✅ 容量 0 拒绝（400）"; PASS=$((PASS+1)); } || { echo "❌ 容量 0 应 400，实际 $R"; FAIL=$((FAIL+1)); }
R=$(curl -s -X POST "$BASE/api/capacity" -H 'Content-Type: application/json' -d '{"globalLimit":"abc"}')
check "非数字报错" "正整数" "$R"
R=$(curl -s -X POST "$BASE/api/capacity" -H 'Content-Type: application/json' -d '{"domainLimits":{"   ":2}}')
check "空域名报错" "空的域名" "$R"

post /api/reset '{}' >/dev/null
J=$(curl -s "$BASE/api/jar")
check "重置保留容量设置（globalLimit=2）" '"globalLimit":2' "$J"

echo "== P15. IP 主机按完整主机独立分桶 =="
post /api/capacity '{"domainLimits":{"10.1.1.1":1}}' >/dev/null
post /api/store '{"url":"http://10.1.1.1/","setCookie":"ip1=1; Path=/"}' >/dev/null
R=$(post /api/store '{"url":"http://10.1.1.1/","setCookie":"ip2=2; Path=/"}')
check "同 IP 超限淘汰" '"cookie":"ip1=1"' "$R"
R=$(post /api/store '{"url":"http://10.1.1.2/","setCookie":"ip3=3; Path=/"}')
if [[ "$R" != *'"cookie":"ip3=3"'*'"reason":"evicted"'* ]] && [[ "$R" != *'"triggered": true'* ]]; then echo "✅ 另一 IP 独立桶不触发"; PASS=$((PASS+1)); else echo "❌ IP 桶未独立"; FAIL=$((FAIL+1)); fi

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo
echo "------- Partitioned（CHIPS 独立分区）写入演算 -------"

echo "== C1. Partitioned 未带 Secure -> 拒绝 =="
R=$(post /api/store '{"url":"https://widget.vendor.com/","setCookie":"ch=1; Path=/; Partitioned","topUrl":"https://site-a.example/"}')
check "拒绝" '"action":"rejected"' "$R"
check "拒绝原因（必须带 Secure）" "必须同时声明 Secure" "$R"

echo "== C2. Partitioned 未提供顶层 URL -> 拒绝 =="
R=$(post /api/store '{"url":"https://widget.vendor.com/","setCookie":"ch=1; Path=/; Secure; Partitioned"}')
check "拒绝" '"action":"rejected"' "$R"
check "拒绝原因（缺少顶层 URL）" "顶层页面 URL" "$R"

echo "== C3. Partitioned 顶层 URL 非法（非 http(s)）-> 拒绝 =="
R=$(post /api/store '{"url":"https://widget.vendor.com/","setCookie":"ch=1; Path=/; Secure; Partitioned","topUrl":"ftp://site-a.example/"}')
check "拒绝" '"action":"rejected"' "$R"
check "拒绝原因（URL 非法或非 http(s)）" "非法或非 http" "$R"

echo "== C4. 普通 cookie 带不带 topUrl 都照常入罐（topUrl 被忽略） =="
R=$(post /api/store '{"url":"https://widget.vendor.com/","setCookie":"plain=1; Path=/; Secure","topUrl":"https://site-a.example/"}')
check "普通项入罐" '"action":"stored"' "$R"
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
c=d['cookie']
assert c['partitioned'] is False and c['partitionKey'] is None, c
print('✅ 普通项 partitioned=false、partitionKey=null')" && PASS=$((PASS+1)) || { echo "❌ 普通项分区字段错误"; FAIL=$((FAIL+1)); }

echo "== C5. Partitioned 合法入罐（分区键 site-a = scheme+可注册域，忽略路径/端口） =="
R=$(post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch=a; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://www.site-a.example:8443/home?q=1"}')
check "入罐" '"action":"stored"' "$R"
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
c=d['cookie']
assert c['partitioned'] is True, c
assert c['partitionKey']=='https://site-a.example', c['partitionKey']
print('✅ 分区键 https://site-a.example（去子域/端口/路径）')" && PASS=$((PASS+1)) || { echo "❌ 分区键计算错误"; FAIL=$((FAIL+1)); }
check "入罐提示给出分区键" "分区键取顶层页面" "$R"

echo "== C6. 另一分区同名同域同路径项并存（不是覆盖） =="
R=$(post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch=b; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://site-b.example/"}')
check "入罐（非更新）" '"action":"stored"' "$R"
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
parts=sorted((c['value'],c['partitionKey']) for c in d['jar'] if c['name']=='ch')
assert parts==[('a','https://site-a.example'),('b','https://site-b.example')], parts
print('✅ 两个分区项并存')" && PASS=$((PASS+1)) || { echo "❌ 分区项未并存"; FAIL=$((FAIL+1)); }

echo "== C7. 普通项同名同域同路径也并存 =="
R=$(post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch=u; Path=/; Secure; SameSite=None"}')
check "普通项入罐（非更新）" '"action":"stored"' "$R"
J=$(curl -s "$BASE/api/jar")
echo "$J" | python3 -c "
import sys,json
d=json.load(sys.stdin)
rows=[c for c in d['cookies'] if c['name']=='ch']
assert len(rows)==3, len(rows)
labels=sorted(c['partitionLabel'] for c in rows)
print('✅ 罐中 ch 共 3 条（2 分区 + 1 未分区）:', labels)" && PASS=$((PASS+1)) || { echo "❌ 普通项未与分区项并存"; FAIL=$((FAIL+1)); }

echo "== C8. 同分区覆盖只更新该分区，沿用创建序号 =="
R=$(post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch=aa; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://site-a.example/"}')
check "更新动作" '"action":"updated"' "$R"
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['inheritedIndex']==2, d
vals=sorted((c['value'],str(c['partitionKey'])) for c in d['jar'] if c['name']=='ch')
assert vals==[('aa','https://site-a.example'),('b','https://site-b.example'),('u','None')], vals
print('✅ 仅 site-a 分区被覆盖为 aa，site-b 与普通项不变')" && PASS=$((PASS+1)) || { echo "❌ 覆盖越区"; FAIL=$((FAIL+1)); }

echo "== C9. Max-Age=0 只删除对应分区 =="
R=$(post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch=; Path=/; Secure; Partitioned; Max-Age=0","topUrl":"https://site-a.example/"}')
check "删除动作" '"action":"deleted"' "$R"
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
vals=sorted((c['value'],str(c['partitionKey'])) for c in d['jar'] if c['name']=='ch')
assert vals==[('b','https://site-b.example'),('u','None')], vals
print('✅ site-a 项删除，site-b 分区项与普通项保留')" && PASS=$((PASS+1)) || { echo "❌ 删除越区"; FAIL=$((FAIL+1)); }

echo "== C10. 再次删除该分区：无可删除，不影响其他分区 =="
R=$(post /api/store '{"url":"https://widget.vendor.com/","setCookie":"ch=; Path=/; Secure; Partitioned; Max-Age=0","topUrl":"https://site-a.example/"}')
check "删除动作（无目标）" '"action":"deleted"' "$R"
check "提示不影响其他分区" "不影响其他分区" "$R"

echo
echo "------- Partitioned（CHIPS）发送演算 -------"

echo "== S1. 分区键相同：该分区项 + 普通项发送，其他分区项排除 =="
# 先补入 site-a 分区项（C9 已删除），制造键不同被排除的场景
post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch=a2; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://site-a.example/"}' >/dev/null
R=$(post /api/send '{"url":"https://widget.vendor.com/frame/x","topUrl":"https://site-b.example/p","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "回显请求分区键" '"partitionKey":"https://site-b.example"' "$R"
check "site-b 分区项发送" "ch=b" "$HDR"
check "普通项发送" "ch=u" "$HDR"
check "排除明细（分区键不同）" "≠ 请求分区键" "$R"
if [[ "$HDR" != *"ch=a2"* ]]; then echo "✅ site-a 分区项键不同不发送"; PASS=$((PASS+1));
else echo "❌ site-a 分区项被误发"; FAIL=$((FAIL+1)); fi

echo "== S2. 顶层页换成第三分区：两个分区项都排除，仅普通项发送 =="
R=$(post /api/send '{"url":"https://widget.vendor.com/","topUrl":"https://site-c.example/","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "仅普通项发送" "ch=u" "$HDR"
if [[ "$HDR" != *"ch=b"* ]]; then echo "✅ site-b 分区项跨分区不发送"; PASS=$((PASS+1));
else echo "❌ 分区项被跨分区发送"; FAIL=$((FAIL+1)); fi
check "排除明细说明分区键" "Partitioned 分区 cookie 仅在其分区内发送" "$R"
N_EXCL=$(echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(sum(1 for i in d['excluded'] if i['name']=='ch' and i['partitioned'] and '请求分区键' in i['detail']))")
[ "$N_EXCL" = "2" ] && { echo "✅ 2 个分区项（site-a/site-b）均以分区键不符排除"; PASS=$((PASS+1)); } || { echo "❌ 分区排除条数错误: $N_EXCL"; FAIL=$((FAIL+1)); }

echo "== S3. 缺省 topUrl（=请求 URL）：分区键按请求 URL 计算，分区项不匹配 =="
R=$(post /api/send '{"url":"https://widget.vendor.com/"}')
check "分区键缺省回退为请求站" '"partitionKey":"https://vendor.com"' "$R"
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"ch=b"* ]]; then echo "✅ 分区项在缺省上下文不发送"; PASS=$((PASS+1));
else echo "❌ 缺省上下文误发分区项"; FAIL=$((FAIL+1)); fi

echo "== S4. IP / localhost 分区键用完整主机（端口忽略，scheme 参与） =="
post /api/store '{"url":"https://widget.vendor.com/","setCookie":"chip=1; Path=/; Secure; SameSite=None; Partitioned","topUrl":"http://192.168.1.6/"}' >/dev/null
R=$(post /api/send '{"url":"https://widget.vendor.com/","topUrl":"http://192.168.1.6:8080/a"}')
check "IP 分区键完整主机" '"partitionKey":"http://192.168.1.6"' "$R"
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "同 IP（忽略端口）分区项发送" "chip=1" "$HDR"
R=$(post /api/send '{"url":"https://widget.vendor.com/","topUrl":"http://192.168.1.7/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"chip=1"* ]]; then echo "✅ 不同 IP 跨分区不发送"; PASS=$((PASS+1));
else echo "❌ 不同 IP 误发"; FAIL=$((FAIL+1)); fi
R=$(post /api/send '{"url":"https://widget.vendor.com/","topUrl":"https://192.168.1.6/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"chip=1"* ]]; then echo "✅ scheme 不同（http vs https）分区键不同，不发送"; PASS=$((PASS+1));
else echo "❌ schemeful 分区键判定错误"; FAIL=$((FAIL+1)); fi

echo "== S5. 分区项同样受 Secure / Domain / Path / SameSite 约束 =="
# chip 是 Secure，明文 http 请求即便分区键相同也应被 Secure 规则排除（widget 是 https 主机，这里换明文同主机名）
R=$(post /api/send '{"url":"http://widget.vendor.com/","topUrl":"http://192.168.1.6/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"chip=1"* ]]; then echo "✅ 明文 http 不发送 Secure 分区项"; PASS=$((PASS+1));
else echo "❌ 分区项绕过 Secure 限制"; FAIL=$((FAIL+1)); fi
# 不相关主机：分区键相同但 Domain 不匹配，排除（检查 Cookie 头而非整个 JSON，排除项也会含 chip=1 字样）
R=$(post /api/send '{"url":"https://other.host.net/","topUrl":"http://192.168.1.6/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "分区键相同但主机不匹配仍排除" "host-only cookie 仅匹配原主机" "$R"
if [[ "$HDR" != *"chip=1"* ]]; then echo "✅ chip 未出现在其他主机的 Cookie 头（$HDR）"; PASS=$((PASS+1));
else echo "❌ chip 误发到其他主机"; FAIL=$((FAIL+1)); fi

post /api/reset '{}' >/dev/null

echo "== S6. 分区项计入域级与全局容量 =="
post /api/capacity '{"globalLimit":3,"domainLimits":{"vendor.com":2}}' >/dev/null
post /api/store '{"url":"https://w.vendor.com/","setCookie":"k=1; Path=/; Secure; Partitioned","topUrl":"https://a.example/"}' >/dev/null
post /api/store '{"url":"https://w.vendor.com/","setCookie":"k=2; Path=/; Secure; Partitioned","topUrl":"https://b.example/"}' >/dev/null
R=$(post /api/store '{"url":"https://w.vendor.com/","setCookie":"k=3; Path=/; Secure; Partitioned","topUrl":"https://c.example/"}')
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
stages=d['eviction']['stages']
ds=stages[0]
assert ds['scope']=='domain' and ds['domain']=='vendor.com', ds
assert ds['beforeCount']==3 and ds['triggered'], ds
assert ds['removed'][0]['partitioned'] is True and ds['removed'][0]['partitionKey']=='https://a.example', ds
assert d['capacity']['totalCount']==2, d['capacity']
print('✅ 3 个不同分区项同计 vendor.com 桶，超限按规则淘汰且报告带分区键；全局总数=2')" && PASS=$((PASS+1)) || { echo "❌ 分区项容量统计错误"; FAIL=$((FAIL+1)); }

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo
echo "------- 屏蔽第三方 Cookie（blockThirdParty）写入演算 -------"

echo "== T1. 开启后缺少顶层页面 URL -> 拒绝（即使普通 cookie） =="
R=$(post /api/store '{"url":"https://a.example/","setCookie":"t1=1; Path=/","blockThirdParty":true}')
check "拒绝" '"action":"rejected"' "$R"
check "原因（必须提供顶层页面 URL）" "必须提供有效的顶层页面 URL" "$R"

echo "== T2. 开启后顶层页面 URL 非法 -> 拒绝 =="
R=$(post /api/store '{"url":"https://a.example/","setCookie":"t1=1; Path=/","topUrl":"not-a-url","blockThirdParty":true}')
check "拒绝" '"action":"rejected"' "$R"
check "原因（URL 非法）" "非法或非 http" "$R"

echo "== T3. 跨站响应的普通 Cookie 拒绝写入，罐不变、不触发容量淘汰 =="
post /api/capacity '{"globalLimit":1}' >/dev/null
post /api/store '{"url":"https://keep.example/","setCookie":"keep=1; Path=/"}' >/dev/null
R=$(post /api/store '{"url":"https://tracker.vendor.com/","setCookie":"trk=1; Path=/","topUrl":"https://shop.example.com/","blockThirdParty":true}')
check "拒绝" '"action":"rejected"' "$R"
check "原因（跨站拒绝写入普通 Cookie）" "拒绝写入普通 Cookie" "$R"
check "给出站点对比" "响应站 https://vendor.com ≠ 顶层站 https://example.com" "$R"
check "提示不触发容量淘汰" "不触发容量淘汰" "$R"
J=$(curl -s "$BASE/api/jar")
check "罐中仅剩 keep（全局上限 1 未触发淘汰）" '"totalCount":1' "$J"
check "keep 未被淘汰" "keep" "$J"

echo "== T4. 跨站响应的普通 Cookie 删除（Max-Age=0）也被拒绝 =="
R=$(post /api/store '{"url":"https://keep.example.evil.net/","setCookie":"keep=; Path=/; Max-Age=0","topUrl":"https://shop.example.com/","blockThirdParty":true}')
check "拒绝" '"action":"rejected"' "$R"
check "原因（跨站拒绝删除普通 Cookie）" "拒绝删除普通 Cookie" "$R"
J=$(curl -s "$BASE/api/jar")
check "keep 仍在罐中（删除被拒绝）" "keep" "$J"
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== T5. 同站响应开启屏蔽也正常入罐 =="
R=$(post /api/store '{"url":"https://api.shop.example.com/","setCookie":"same=1; Path=/","topUrl":"https://shop.example.com/","blockThirdParty":true}')
check "入罐" '"action":"stored"' "$R"

echo "== T6. 跨站响应的 Partitioned 分区项不受屏蔽影响（仍按 Secure+分区键规则入罐） =="
R=$(post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch=1; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://shop.example.com/","blockThirdParty":true}')
check "分区项跨站入罐" '"action":"stored"' "$R"
check "分区键正确（shop.example.com 的可注册域）" '"partitionKey":"https://example.com"' "$R"
R=$(post /api/store '{"url":"https://widget.vendor.com/frame","setCookie":"ch2=1; Path=/; Partitioned","topUrl":"https://shop.example.com/","blockThirdParty":true}')
check "Partitioned 未带 Secure 仍按既有规则拒绝" '"action":"rejected"' "$R"
check "拒绝原因（必须带 Secure）" "必须同时声明 Secure" "$R"

echo "== T7. 关闭开关（默认）跨站普通 Cookie 照常入罐 =="
R=$(post /api/store '{"url":"https://tracker.vendor.com/","setCookie":"trk=2; Path=/","topUrl":"https://shop.example.com/"}')
check "默认不屏蔽，入罐" '"action":"stored"' "$R"

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo
echo "------- 屏蔽第三方 Cookie（blockThirdParty）发送演算 -------"

post /api/store '{"url":"https://widget.vendor.com/","setCookie":"plain=1; Path=/; Secure; SameSite=None"}' >/dev/null
post /api/store '{"url":"https://widget.vendor.com/","setCookie":"ch=p; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://site-a.example/"}' >/dev/null

echo "== U1. 开启后缺少顶层页面 URL -> 报错 =="
R=$(post /api/send '{"url":"https://widget.vendor.com/","blockThirdParty":true}')
check "报错" '"ok":false' "$R"
check "原因（必须提供顶层页面 URL）" "必须提供有效的顶层页面 URL" "$R"
check "回显开关状态" '"blockThirdParty":true' "$R"

echo "== U2. 跨站请求：普通项排除，分区键匹配的 Partitioned 仍发送 =="
R=$(post /api/send '{"url":"https://widget.vendor.com/","topUrl":"https://site-a.example/","blockThirdParty":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "回显开关状态" '"blockThirdParty":true' "$R"
check "跨站标记" '"sameSiteContext":false' "$R"
check "分区项发送" "ch=p" "$HDR"
check "普通项排除原因（屏蔽第三方）" "屏蔽第三方 Cookie：跨站请求" "$R"
check "豁免说明（分区键匹配的 Partitioned 项）" "豁免" "$R"
if [[ "$HDR" != *"plain=1"* ]]; then echo "✅ 普通项被第三方屏蔽排除"; PASS=$((PASS+1));
else echo "❌ 普通项跨站被误发（$HDR）"; FAIL=$((FAIL+1)); fi

echo "== U3. 同站请求开启屏蔽：普通项照常发送 =="
R=$(post /api/send '{"url":"https://widget.vendor.com/","topUrl":"https://widget.vendor.com/","blockThirdParty":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "同站标记" '"sameSiteContext":true' "$R"
check "普通项发送" "plain=1" "$HDR"

echo "== U4. 关闭开关（默认）跨站普通项照常发送（SameSite=None） =="
R=$(post /api/send '{"url":"https://widget.vendor.com/","topUrl":"https://site-a.example/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "回显开关关闭" '"blockThirdParty":false' "$R"
check "普通项发送" "plain=1" "$HDR"

echo "== U5. 被屏蔽排除的条目不刷新最近访问时间 =="
post /api/reset '{}' >/dev/null
post /api/capacity '{"domainLimits":{"lra3p.test":2}}' >/dev/null
post /api/store '{"url":"https://lra3p.test/","setCookie":"a=1; Path=/a; Priority=Medium"}' >/dev/null
adv 1
post /api/store '{"url":"https://lra3p.test/","setCookie":"b=2; Path=/b; Priority=Medium"}' >/dev/null
adv 1
# 同站请求 /b/x：仅 b 命中路径并发送，b 的最近访问时间被刷新；a 不动
post /api/send '{"url":"https://lra3p.test/b/x"}' >/dev/null
adv 1
# 跨站 + 屏蔽请求 /a/x：a 命中路径但被第三方屏蔽排除，最近访问时间不得刷新
R=$(post /api/send '{"url":"https://lra3p.test/a/x","topUrl":"https://other.example/","blockThirdParty":true}')
check "a 被屏蔽排除" "屏蔽第三方 Cookie：跨站请求" "$R"
adv 1
# 写入 c 触发域级淘汰：a 的访问时间最老（屏蔽排除未刷新），应淘汰 a；
# 若屏蔽排除错误地刷新了 a，则最老是 b，断言会失败
R=$(post /api/store '{"url":"https://lra3p.test/","setCookie":"c=3; Path=/c; Priority=Medium"}')
check "淘汰最久未访问的 a（证明屏蔽排除未刷新访问时间）" '"cookie":"a=1"' "$R"

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== U6. blockThirdParty 参数类型校验 =="
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/store" -H 'Content-Type: application/json' -d '{"url":"https://a.example/","setCookie":"x=1","blockThirdParty":"yes"}')
[ "$R" = "400" ] && { echo "✅ /api/store 非布尔 blockThirdParty 拒绝（400）"; PASS=$((PASS+1)); } || { echo "❌ /api/store 应 400，实际 $R"; FAIL=$((FAIL+1)); }
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/send" -H 'Content-Type: application/json' -d '{"url":"https://a.example/","blockThirdParty":1}')
[ "$R" = "400" ] && { echo "✅ /api/send 非布尔 blockThirdParty 拒绝（400）"; PASS=$((PASS+1)); } || { echo "❌ /api/send 应 400，实际 $R"; FAIL=$((FAIL+1)); }

echo
echo "------- document.cookie 脚本写入（/api/script/write）演算 -------"

post /api/reset '{}' >/dev/null
# 网络接口先准备：普通项 normal、未过期 HttpOnly 项 hs、另一名的普通项 other
post /api/store '{"url":"https://js.test/","setCookie":"normal=1; Path=/"}' >/dev/null
post /api/store '{"url":"https://js.test/","setCookie":"hs=secret; Path=/; HttpOnly"}' >/dev/null
post /api/store '{"url":"https://js.test/","setCookie":"other=o; Path=/"}' >/dev/null
# 分区 HttpOnly 项（site-a 分区）
post /api/store '{"url":"https://w.vendor.com/frame","setCookie":"ph=1; Path=/; Secure; HttpOnly; SameSite=None; Partitioned","topUrl":"https://site-a.example/"}' >/dev/null

echo "== D1. 脚本赋值带 HttpOnly -> 拒绝，罐不变 =="
R=$(post /api/script/write '{"url":"https://js.test/","setCookie":"x=1; Path=/; HttpOnly"}')
check "拒绝" '"action":"rejected"' "$R"
check "原因（脚本不能设置 HttpOnly）" "不能设置 HttpOnly" "$R"
check "提示罐内容不变" "罐内容、时间戳与容量均未改动" "$R"
J=$(curl -s "$BASE/api/jar")
check "罐中无 x" '"totalCount":4' "$J"

echo "== D2. 脚本覆盖未过期 HttpOnly 项 -> 拒绝，原值保留 =="
R=$(post /api/script/write '{"url":"https://js.test/","setCookie":"hs=hacked"}')
check "拒绝" '"action":"rejected"' "$R"
check "原因（不能覆盖 HttpOnly）" "不能被脚本改写" "$R"
check "给出身份信息" "同身份" "$R"
curl -s "$BASE/api/jar" | python3 -c "
import sys,json
c=[x for x in json.load(sys.stdin)['cookies'] if x['name']=='hs'][0]
assert c['value']=='secret' and c['httpOnly'] is True, c
print('✅ hs=secret（HttpOnly）原值保留')" && PASS=$((PASS+1)) || { echo "❌ hs 原值未保留"; FAIL=$((FAIL+1)); }
J=$(curl -s "$BASE/api/jar")

echo "== D3. 脚本 Max-Age=0 删除未过期 HttpOnly 项 -> 拒绝 =="
R=$(post /api/script/write '{"url":"https://js.test/","setCookie":"hs=; Path=/; Max-Age=0"}')
check "拒绝" '"action":"rejected"' "$R"
check "原因（不能删除 HttpOnly）" "HttpOnly cookie 的删除只能由网络 Set-Cookie 发起" "$R"
curl -s "$BASE/api/jar" | python3 -c "
import sys,json
c=[x for x in json.load(sys.stdin)['cookies'] if x['name']=='hs'][0]
assert c['value']=='secret' and c['httpOnly'] is True, c
print('✅ hs=secret（HttpOnly）删除被拒绝后仍在罐中')" && PASS=$((PASS+1)) || { echo "❌ hs 被错误删除"; FAIL=$((FAIL+1)); }
J=$(curl -s "$BASE/api/jar")

echo "== D4. 脚本写同身份 HttpOnly 分区项（覆盖/删除）-> 拒绝 =="
R=$(post /api/script/write '{"url":"https://w.vendor.com/frame","setCookie":"ph=2; Path=/; Secure; Partitioned","topUrl":"https://site-a.example/"}')
check "覆盖分区 HttpOnly 拒绝" '"action":"rejected"' "$R"
check "提示带分区身份" "分区 https://site-a.example" "$R"
R=$(post /api/script/write '{"url":"https://w.vendor.com/frame","setCookie":"ph=; Path=/; Secure; Partitioned; Max-Age=0","topUrl":"https://site-a.example/"}')
check "删除分区 HttpOnly 拒绝" '"action":"rejected"' "$R"

echo "== D5. 不同分区的同名分区项不受 HttpOnly 保护（另一分区无此项，可入罐） =="
R=$(post /api/script/write '{"url":"https://w.vendor.com/frame","setCookie":"ph=3; Path=/; Secure; Partitioned","topUrl":"https://site-b.example/"}')
check "另一分区入罐" '"action":"stored"' "$R"

echo "== D6. 脚本正常写普通项（新项/覆盖/删除）复用既有逻辑 =="
R=$(post /api/script/write '{"url":"https://js.test/","setCookie":"new=1; Path=/; Max-Age=100"}')
check "新项入罐" '"action":"stored"' "$R"
R=$(post /api/script/write '{"url":"https://js.test/","setCookie":"normal=2"}')
check "普通项覆盖更新" '"action":"updated"' "$R"
check "沿用创建序号" '"inheritedIndex":1' "$R"
R=$(post /api/script/write '{"url":"https://js.test/","setCookie":"other=; Max-Age=0"}')
check "普通项 Max-Age=0 删除" '"action":"deleted"' "$R"
J=$(curl -s "$BASE/api/jar")
if echo "$J" | grep -q '"name":"other"'; then echo "❌ other 应已删除"; FAIL=$((FAIL+1));
else echo "✅ other 已删除"; PASS=$((PASS+1)); fi

echo "== D7. 已过期 HttpOnly 项不在保护之列：脚本可顶替 =="
post /api/store '{"url":"https://js.test/","setCookie":"dying=old; Path=/; Max-Age=1; HttpOnly"}' >/dev/null
adv 2
R=$(post /api/script/write '{"url":"https://js.test/","setCookie":"dying=new; Path=/"}')
check "过期 HttpOnly 可被脚本覆盖" '"action":"updated"' "$R"
J=$(curl -s "$BASE/api/jar")
check "值已更新且不再 HttpOnly" '"name":"dying"' "$J"

echo "== D8. 脚本写入仍受第三方屏蔽规则约束 =="
R=$(post /api/script/write '{"url":"https://tracker.vendor.com/","setCookie":"trk=1; Path=/","topUrl":"https://shop.example.com/","blockThirdParty":true}')
check "跨站拒绝" '"action":"rejected"' "$R"
check "原因（屏蔽第三方）" "拒绝写入普通 Cookie" "$R"

echo "== D9. 脚本写入复用容量淘汰逻辑 =="
post /api/capacity '{"domainLimits":{"capd.test":1}}' >/dev/null
post /api/script/write '{"url":"https://capd.test/","setCookie":"hi=1; Path=/; Priority=High"}' >/dev/null
R=$(post /api/script/write '{"url":"https://capd.test/","setCookie":"lo=2; Path=/; Priority=Low"}')
check "脚本写入触发容量淘汰" '"cookie":"lo=2"' "$R"
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== D10. 网络接口 /api/store 仍可覆盖与删除 HttpOnly 项 =="
R=$(post /api/store '{"url":"https://js.test/","setCookie":"hs=net; Path=/; HttpOnly"}')
check "网络覆盖 HttpOnly" '"action":"updated"' "$R"
R=$(post /api/store '{"url":"https://js.test/","setCookie":"hs=; Path=/; Max-Age=0; HttpOnly"}')
check "网络删除 HttpOnly" '"action":"deleted"' "$R"
J=$(curl -s "$BASE/api/jar")
if echo "$J" | grep -q '"name":"hs"'; then echo "❌ hs 应已被网络接口删除"; FAIL=$((FAIL+1));
else echo "✅ hs 已被网络接口删除"; PASS=$((PASS+1)); fi

echo
echo "------- document.cookie 脚本读取（/api/script/read）演算 -------"

post /api/reset '{}' >/dev/null
# 普通项 + HttpOnly 项（js.test 同站）；Secure 普通项；Strict 普通项；分区项两个
post /api/store '{"url":"https://js.test/app","setCookie":"vis=1; Path=/app"}' >/dev/null
post /api/store '{"url":"https://js.test/app","setCookie":"secret=h; Path=/app; HttpOnly"}' >/dev/null
post /api/store '{"url":"https://js.test/","setCookie":"ss=1; Path=/; SameSite=Strict"}' >/dev/null
post /api/store '{"url":"https://w.vendor.com/frame","setCookie":"pa=A; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://site-a.example/"}' >/dev/null
post /api/store '{"url":"https://w.vendor.com/frame","setCookie":"pb=B; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://site-b.example/"}' >/dev/null
post /api/store '{"url":"http://js.test/","setCookie":"insec=1; Path=/"}' >/dev/null

echo "== E1. 脚本读取：普通项可读，HttpOnly 排除（不应用 SameSite） =="
R=$(post /api/script/read '{"url":"https://js.test/app/x"}')
STR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieString'])")
check "普通项 vis 可读" "vis=1" "$STR"
check "Strict 项 ss 不被 SameSite 拦截" "ss=1" "$STR"
if [[ "$STR" != *"secret=h"* ]]; then echo "✅ HttpOnly secret 不出现在 document.cookie"; PASS=$((PASS+1));
else echo "❌ HttpOnly 被脚本读到"; FAIL=$((FAIL+1)); fi
check "HttpOnly 排除原因" "document.cookie 不可见" "$R"
N_EXCL=$(echo "$R" | python3 -c "import sys,json;print(sum(1 for i in json.load(sys.stdin)['excluded'] if i['name']=='secret' and i['httpOnly']))")
[ "$N_EXCL" = "1" ] && { echo "✅ secret 以 HttpOnly 原因逐项排除"; PASS=$((PASS+1)); } || { echo "❌ HttpOnly 排除条数错误"; FAIL=$((FAIL+1)); }

echo "== E2. 读取字符串沿用请求头排序（Path 长度降序，创建序号升序） =="
post /api/store '{"url":"https://js.test/","setCookie":"r=1; Path=/"}' >/dev/null
post /api/store '{"url":"https://js.test/","setCookie":"m=1; Path=/app"}' >/dev/null
R=$(post /api/script/read '{"url":"https://js.test/app/x"}')
STR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieString'])")
# /app 组（vis, m 按创建顺序）应在 / 组（ss, r）之前
echo "$R" | python3 -c "
import sys
s='''$STR'''
order=[p.split('=')[0] for p in s.split('; ')]
assert order.index('vis') < order.index('m') < order.index('ss'), order
assert order.index('ss') < order.index('r'), order
assert order.index('m') < order.index('ss'), order
print('✅ 排序:', '; '.join(order))" && PASS=$((PASS+1)) || { echo "❌ 排序错误: $STR"; FAIL=$((FAIL+1)); }

echo "== E3. 分区读取：仅分区键相同的分区项可读，另一分区逐项说明原因 =="
R=$(post /api/script/read '{"url":"https://w.vendor.com/frame","topUrl":"https://site-a.example/"}')
STR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieString'])")
check "site-a 分区项可读" "pa=A" "$STR"
if [[ "$STR" != *"pb=B"* ]]; then echo "✅ site-b 分区项不可读"; PASS=$((PASS+1));
else echo "❌ 跨分区项被读到"; FAIL=$((FAIL+1)); fi
check "回显页面分区键" '"partitionKey":"https://site-a.example"' "$R"
check "跨分区排除原因" "≠ 页面分区键" "$R"

echo "== E4. 第三方屏蔽：跨站页面普通项排除，分区键匹配的分区项仍可读 =="
R=$(post /api/script/read '{"url":"https://w.vendor.com/frame","topUrl":"https://site-a.example/","blockThirdParty":true}')
STR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieString'])")
check "分区项可读" "pa=A" "$STR"
check "普通项跨站屏蔽原因" "跨站页面" "$R"
# js.test 的 host-only 普通项本就因 Domain 不匹配排除，不影响断言

echo "== E5. 屏蔽开启缺 topUrl -> 报错并回显开关 =="
R=$(post /api/script/read '{"url":"https://w.vendor.com/frame","blockThirdParty":true}')
check "报错" '"ok":false' "$R"
check "原因" "必须提供有效的顶层页面 URL" "$R"
check "回显开关" '"blockThirdParty":true' "$R"

echo "== E6. Secure 检查：明文 http 页面读不到 Secure cookie =="
post /api/store '{"url":"http://plain-sec.test/","setCookie":"sp=1; Path=/; Secure"}' >/dev/null
R=$(post /api/script/read '{"url":"http://plain-sec.test/"}')
check "Secure 排除原因" "仅在 https 页面可读" "$R"
# 同一主机 https 页面则可读（脚本视角同样满足 Secure）
R=$(post /api/script/read '{"url":"https://plain-sec.test/"}')
check "https 页面可读 Secure 项" "sp=1" "$R"

echo "== E7. 过期项读取排除并说明原因 =="
post /api/store '{"url":"https://js.test/","setCookie":"q=1; Path=/; Max-Age=1"}' >/dev/null
adv 2
R=$(post /api/script/read '{"url":"https://js.test/"}')
check "过期排除原因" "document.cookie 读不到" "$R"
STR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieString'])")
if [[ "$STR" != *"q=1"* ]]; then echo "✅ 过期项不在读取字符串"; PASS=$((PASS+1));
else echo "❌ 过期项被读到"; FAIL=$((FAIL+1)); fi

echo "== E8. 脚本读取为纯只读：不刷新最近访问时间（用容量 LRA 证明） =="
post /api/reset '{}' >/dev/null
post /api/capacity '{"domainLimits":{"lras.test":2}}' >/dev/null
post /api/store '{"url":"https://lras.test/a","setCookie":"a=1; Path=/a; Priority=Medium"}' >/dev/null
adv 1
post /api/store '{"url":"https://lras.test/b","setCookie":"b=2; Path=/b; Priority=Medium"}' >/dev/null
adv 1
post /api/script/read '{"url":"https://lras.test/a/x"}' >/dev/null
adv 1
R=$(post /api/store '{"url":"https://lras.test/c","setCookie":"c=3; Path=/c; Priority=Medium"}')
check "淘汰最久未访问的 a（脚本读取未刷新访问时间）" '"cookie":"a=1"' "$R"
post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== E9. 非法 URL / 参数校验 =="
R=$(post /api/script/read '{"url":"not-a-url"}')
check "非法页面 URL" '"ok":false' "$R"
R=$(post /api/script/read '{"url":"https://js.test/","topUrl":"bad"}')
check "非法顶层 URL" "顶层页面 URL 非法" "$R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/script/read" -H 'Content-Type: application/json' -d '{"url":"https://js.test/","blockThirdParty":"x"}')
[ "$R" = "400" ] && { echo "✅ /api/script/read 非布尔参数 400"; PASS=$((PASS+1)); } || { echo "❌ 应 400，实际 $R"; FAIL=$((FAIL+1)); }
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/script/write" -H 'Content-Type: application/json' -d '{"url":"https://js.test/"}')
[ "$R" = "400" ] && { echo "✅ /api/script/write 缺 setCookie 400"; PASS=$((PASS+1)); } || { echo "❌ 应 400，实际 $R"; FAIL=$((FAIL+1)); }

post /api/reset '{}' >/dev/null

echo
echo "------- 演算时钟（/api/clock + /api/clock/advance）演算 -------"

echo "== Z1. 启动时时钟固定，读取接口返回当前演算时间 =="
R=$(curl -s "$BASE/api/clock")
check "clock ok" '"ok":true' "$R"
check "已推进 0 秒" '"elapsedSeconds":0' "$R"
check "含启动时刻" '"startedAt"' "$R"
J=$(curl -s "$BASE/api/jar")
check "jar 快照携带时钟" '"clock"' "$J"

echo "== Z2. Max-Age 过期随推进逐步复现；推进本身不删除条目 =="
post /api/store '{"url":"https://clk.test/","setCookie":"m=1; Path=/; Max-Age=60"}' >/dev/null
R=$(post /api/clock/advance '{"seconds":30}')
check "推进 30 秒" '"elapsedSeconds":30' "$R"
check "推进后条目仍在罐中" '"name":"m"' "$R"
check "30 秒时未过期" '"expired":false' "$R"
R=$(post /api/send '{"url":"https://clk.test/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "30 秒时仍发送" "m=1" "$HDR"
R=$(post /api/clock/advance '{"seconds":31}')
check "推进到 61 秒" '"elapsedSeconds":61' "$R"
check "条目仍留罐（推进不删除）" '"name":"m"' "$R"
check "已标记过期" '"expired":true' "$R"
R=$(post /api/send '{"url":"https://clk.test/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"m=1"* ]]; then echo "✅ 过期后不再发送"; PASS=$((PASS+1));
else echo "❌ 过期后仍被发送（$HDR）"; FAIL=$((FAIL+1)); fi
check "排除原因标注已过期" "已过期" "$R"
J=$(curl -s "$BASE/api/jar")
check "罐快照仍含过期条目（标灰保留）" '"name":"m"' "$J"

echo "== Z3. 非法推进输入：400，时钟与罐均不变 =="
for bad in '{"seconds":0}' '{"seconds":-3}' '{"seconds":1.5}' '{"seconds":"abc"}' '{}'; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/clock/advance" -H 'Content-Type: application/json' -d "$bad")
  if [ "$CODE" = "400" ]; then echo "✅ 非法输入 $bad -> 400"; PASS=$((PASS+1));
  else echo "❌ $bad 应 400，实际 $CODE"; FAIL=$((FAIL+1)); fi
done
R=$(post /api/clock/advance '{"seconds":0}')
check "非法输入报错信息" "正整数" "$R"
R=$(curl -s "$BASE/api/clock")
check "时钟未变（仍 61 秒）" '"elapsedSeconds":61' "$R"
J=$(curl -s "$BASE/api/jar")
check "罐未变（m 仍在）" '"name":"m"' "$J"

echo "== Z4. 推进后的过期清理由容量淘汰按既有规则触发 =="
post /api/reset '{}' >/dev/null
post /api/capacity '{"domainLimits":{"clk2.test":2}}' >/dev/null
post /api/store '{"url":"https://clk2.test/","setCookie":"old=1; Path=/; Max-Age=10; Priority=High"}' >/dev/null
post /api/store '{"url":"https://clk2.test/","setCookie":"keep=1; Path=/; Priority=Low"}' >/dev/null
adv 11
R=$(post /api/store '{"url":"https://clk2.test/","setCookie":"new=1; Path=/; Priority=Medium"}')
check "超限先清理过期项" '"expiredRemoved":1' "$R"
check "过期清理的是 old" '"cookie":"old=1"' "$R"
check "无需优先级淘汰" '"evictedCount":0' "$R"
check "Low 项存活" '"name":"keep"' "$R"
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo "== Z5. document.cookie 读写同样使用演算时钟 =="
post /api/reset '{}' >/dev/null
post /api/script/write '{"url":"https://clk3.test/","setCookie":"sc=1; Path=/; Max-Age=5"}' >/dev/null
adv 6
R=$(post /api/script/read '{"url":"https://clk3.test/"}')
STR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieString'])")
if [[ "$STR" != *"sc=1"* ]]; then echo "✅ 推进后脚本读不到过期项"; PASS=$((PASS+1));
else echo "❌ 脚本读到过期项（$STR）"; FAIL=$((FAIL+1)); fi
check "脚本读取过期原因" "document.cookie 读不到" "$R"

echo "== Z6. 重置罐同步重置时钟 =="
R=$(post /api/reset '{}')
check "重置后已推进 0 秒" '"elapsedSeconds":0' "$R"
check "重置提示时钟复位" "演算时钟" "$R"
post /api/reset '{}' >/dev/null

echo
echo "------- 场景快照（/api/snapshot + /api/snapshot/import）演算 -------"

SNAP_FILE="$(dirname "$0")/test-snapshot.tmp.json"
trap 'rm -f "$SNAP_FILE"' EXIT

echo "== Q1. 准备场景（容量规则 + 普通/分区条目 + 时钟推进 + 已过期项） =="
post /api/capacity '{"globalLimit":9,"domainLimits":{"example.com":7}}' >/dev/null
post /api/store '{"url":"https://shop.example.com/admin","setCookie":"qk=1; Path=/admin; Max-Age=30; Priority=High"}' >/dev/null
post /api/store '{"url":"https://example.com/","setCookie":"qp=2; Path=/; SameSite=None; Secure"}' >/dev/null
post /api/store '{"url":"https://w.vendor.com/frame","setCookie":"qc=3; Path=/; Secure; SameSite=None; Partitioned","topUrl":"https://site-a.example/"}' >/dev/null
adv 100
# qk 已过期（Max-Age=30，已推进 100 秒）
J=$(curl -s "$BASE/api/jar")
echo "$J" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['clock']['elapsedSeconds']==100, d['clock']
rows={c['name']:c for c in d['cookies']}
assert rows['qk']['expired'] is True, rows['qk']
assert rows['qc']['partitionKey']=='https://site-a.example', rows['qc']
print('✅ 场景就绪：3 条（qk 已过期、qc 为 site-a 分区项）、时钟 100 秒')" && PASS=$((PASS+1)) || { echo "❌ 场景准备失败"; FAIL=$((FAIL+1)); }

echo "== Q2. 下载快照：带 format/version，含原始条目/分区键/序号/时间/容量/时钟/下一序号 =="
curl -s "$BASE/api/snapshot" -o "$SNAP_FILE"
python3 - "$SNAP_FILE" <<'EOF'
import sys,json
s=json.load(open(sys.argv[1]))['snapshot']
assert s['format']=='cookie-jar-lab-snapshot', s.get('format')
assert s['version']==1, s.get('version')
assert isinstance(s['exportedAt'],int) and s['exportedAt']>0
assert [c['creationIndex'] for c in s['cookies']]==[1,2,3], s['cookies']
assert s['nextIndex']==4, s['nextIndex']
assert s['capacity']['globalLimit']==9, s['capacity']
assert s['capacity']['domainLimits']==[{'domain':'example.com','limit':7}], s['capacity']
assert s['clock']['now']-s['clock']['startedAt']==100_000, s['clock']
qk=[c for c in s['cookies'] if c['name']=='qk'][0]
assert qk['expiresAt'] is not None and qk['createdAt']==s['clock']['startedAt']
assert qk['lastAccessedAt']==s['clock']['startedAt']
qc=[c for c in s['cookies'] if c['name']=='qc'][0]
assert qc['partitioned'] is True and qc['partitionKey']=='https://site-a.example'
print('✅ 快照字段完整（原始 StoredCookie 条目、容量规则、时钟、下一序号）')
EOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "== Q3. 污染罐（写入无关条目、改容量、重置时钟）后导入：一次性精确替换 =="
post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null
post /api/store '{"url":"https://intruder.test/","setCookie":"zzz=nope; Path=/"}' >/dev/null
adv 7
R=$(curl -s -X POST "$BASE/api/snapshot/import" -H 'Content-Type: application/json' --data @"$SNAP_FILE")
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['ok'] is True, d
assert d['restoredCount']==3, d
assert d['domainLimitCount']==1 and d['globalLimit']==9, d
assert d['clock']['elapsedSeconds']==100, d['clock']
names=[c['name'] for c in d['jar']]
assert names==['qk','qp','qc'], names
assert d['jar'][0]['expired'] is True, '过期项必须原样保留'
assert d['snapshot']['nextIndex']==4
print('✅ 导入恢复 3 条（含过期 qk）、容量规则、时钟 100 秒；入侵者 zzz 消失')" && PASS=$((PASS+1)) || { echo "❌ 导入替换结果错误: $R"; FAIL=$((FAIL+1)); }
J=$(curl -s "$BASE/api/jar")
check "GET /api/jar 与导入后一致（无 zzz）" '"totalCount":3' "$J"

echo "== Q4. 新写入沿用快照下一序号 #4 =="
R=$(post /api/store '{"url":"https://example.com/","setCookie":"qn=4; Path=/"}')
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['cookie']['index']==4, d['cookie']
assert [c['index'] for c in d['jar']]==[1,2,3,4], d['jar']
print('✅ 新条目编号 #4，创建序号连续')" && PASS=$((PASS+1)) || { echo "❌ 下一序号未延续"; FAIL=$((FAIL+1)); }

echo "== Q5. 恢复后行为连续：默认 Lax 120 秒宽限按创建时间、排序一致 =="
# qn(#4, 默认 Lax, 路径 /)创建于时钟 100 秒处；同站请求先发一次刷新其访问时间不影响宽限
R=$(post /api/send '{"url":"https://example.com/","topUrl":"https://other.org/","method":"POST","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
# qn 刚创建 0 秒（时钟仍在 100 秒），默认 Lax 跨站顶层 POST 放行；qp 是 None 也放行
check "刚恢复的默认 Lax 在 120 秒宽限内放行" "qn=4" "$HDR"
adv 121
R=$(post /api/send '{"url":"https://example.com/","topUrl":"https://other.org/","method":"POST","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"qn=4"* ]]; then echo "✅ 恢复 121 秒后默认 Lax 宽限过期（按快照的创建时间计算）"; PASS=$((PASS+1));
else echo "❌ 恢复后 Lax 宽限计算错误"; FAIL=$((FAIL+1)); fi
check "宽限已过原因" "120 秒宽限已过" "$R"
# qp（SameSite=None）跨站照常发送
check "None 项跨站仍发送" "qp=2" "$HDR"
# qk 已过期不发送
if [[ "$HDR" != *"qk=1"* ]]; then echo "✅ 恢复的过期项不发送（但仍在罐中）"; PASS=$((PASS+1));
else echo "❌ 过期项被发送"; FAIL=$((FAIL+1)); fi
J=$(curl -s "$BASE/api/jar")
check "过期项仍保留在罐中" '"name":"qk"' "$J"

echo "== Q6. 恢复后容量淘汰连续：Priority/最近访问/创建序号规则一致 =="
# 当前 4 条（qk 已过期、qp、qc、qn）。设 example.com 域上限 2：
# 超限先清过期 qk；其余 qp(Medium? qp 未声明 Priority=Medium) 与 qn(Medium) 两条 -> 回到 2/2，不再淘汰
R=$(post /api/capacity '{"domainLimits":{"example.com":2}}')
echo "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
stages=[s for s in d['eviction']['stages'] if s['scope']=='domain']
assert stages and stages[0]['expiredRemoved']==1, stages
assert stages[0]['evictedCount']==0, stages
removed=[r['cookie'] for r in stages[0]['removed']]
assert removed==['qk=1'], removed
names=sorted(c['name'] for c in d['cookies'])
assert 'qp' in names and 'qn' in names and 'qk' not in names, names
print('✅ 恢复后超限先清理过期项 qk，未触发优先级淘汰（与导出前连续操作一致）')" && PASS=$((PASS+1)) || { echo "❌ 恢复后淘汰行为异常: $R"; FAIL=$((FAIL+1)); }

echo "== Q7. 各类非法快照 -> 400，且旧罐、容量和时钟均不变 =="
BEFORE=$(curl -s "$BASE/api/jar")
snapshot_reject() { # python-mutation-desc
  local desc="$1"; local mut="$2"
  CODE=$(python3 - "$SNAP_FILE" "$mut" <<'EOF'
import sys,json,urllib.request,urllib.error,copy
s=json.load(open(sys.argv[1]))['snapshot']
mut=sys.argv[2]
if mut=='noformat': s.pop('format',None)
elif mut=='version': s['version']=99
elif mut=='nextindex': s['nextIndex']=2
elif mut=='dup_identity': s['cookies'].append(dict(s['cookies'][1]))
elif mut=='dup_index':
    c=dict(s['cookies'][0]); c['name']='otherx'
    s['cookies'].append(c)
elif mut=='clock_back': s['clock']['now']=s['clock']['startedAt']-1000
elif mut=='clock_half': s['clock']['now']=s['clock']['startedAt']+500
elif mut=='time_future': s['cookies'][0]['createdAt']=s['clock']['now']+1000
elif mut=='time_past': s['cookies'][0]['lastAccessedAt']=s['clock']['startedAt']-1000
elif mut=='none_secure': s['cookies'][1]['secure']=False
elif mut=='enum': s['cookies'][0]['sameSite']='banana'
elif mut=='part_key': s['cookies'][0]['partitioned']=True
elif mut=='cap0': s['capacity']['globalLimit']=0
elif mut=='capneg': s['capacity']['domainLimits'][0]['limit']=-3
req=urllib.request.Request('http://localhost:3000/api/snapshot/import',
    data=json.dumps(s).encode(), headers={'Content-Type':'application/json'}, method='POST')
try:
    urllib.request.urlopen(req); print(200)
except urllib.error.HTTPError as e:
    print(e.code)
EOF
)
  [ "$CODE" = "400" ] && { echo "✅ $desc -> 400"; PASS=$((PASS+1)); } || { echo "❌ $desc 应 400，实际 $CODE"; FAIL=$((FAIL+1)); }
}
snapshot_reject "缺少 format" noformat
snapshot_reject "版本号不受支持" version
snapshot_reject "序号一致性（nextIndex 太小）" nextindex
snapshot_reject "条目身份重复" dup_identity
snapshot_reject "创建序号重复" dup_index
snapshot_reject "时钟当前值早于起点" clock_back
snapshot_reject "时钟非整秒推进" clock_half
snapshot_reject "条目时间晚于当前值" time_future
snapshot_reject "条目时间早于时钟起点" time_past
snapshot_reject "SameSite=None 未带 Secure" none_secure
snapshot_reject "sameSite 枚举非法" enum
snapshot_reject "Partitioned 缺分区键" part_key
snapshot_reject "全局容量 0" cap0
snapshot_reject "域容量为负" capneg

# 非 JSON / 数组
for bad in '[1,2,3]' '{bad json'; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/snapshot/import" -H 'Content-Type: application/json' -d "$bad")
  [ "$CODE" = "400" ] && { echo "✅ 非法载荷（$bad）-> 400"; PASS=$((PASS+1)); } || { echo "❌ 应 400，实际 $CODE"; FAIL=$((FAIL+1)); }
done

AFTER=$(curl -s "$BASE/api/jar")
if [ "$BEFORE" = "$AFTER" ]; then echo "✅ 全部非法导入被拒后旧罐、容量和时钟均不变"; PASS=$((PASS+1));
else echo "❌ 非法导入改动了状态"; FAIL=$((FAIL+1)); fi

# { snapshot } 包裹形式也接受（单独成功用例，不影响上面的不变性对比）
R=$(curl -s -X POST "$BASE/api/snapshot/import" -H 'Content-Type: application/json' \
  -d "{\"snapshot\":$(python3 -c "import json;print(json.dumps(json.load(open('$SNAP_FILE'))['snapshot']))")}")
check "包裹形式 {snapshot} 导入成功" '"ok":true' "$R"

echo
echo "------- 重定向链 /api/redirect-chain -------"

post /api/reset '{}' >/dev/null

echo "== RC1. 基本链：POST -> 303 改 GET（相对 Location）-> 302 跨主机 -> 200 =="
R=$(post /api/redirect-chain '{
  "startUrl":"https://login.example.com/signin","method":"POST",
  "topUrl":"https://shop.example.com/home",
  "steps":[
    {"status":303,"location":"/dashboard","setCookies":["sid=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600"]},
    {"status":302,"location":"https://app.example.com/welcome","setCookies":["t=1; Domain=example.com; Path=/; Secure; SameSite=None"]},
    {"status":200,"setCookies":["fin=x; Path=/; Secure"]}
  ]}')
check "链执行成功" '"ok":true' "$R"
check "3 跳" '"hop":3' "$R"
HM1=$(echo "$R" | python3 -c "import sys,json;h=json.load(sys.stdin)['hops'];print(h[0]['method'])")
HM2=$(echo "$R" | python3 -c "import sys,json;h=json.load(sys.stdin)['hops'];print(h[1]['method'])")
[ "$HM1" = "POST" ] && [ "$HM2" = "GET" ] \
  && { echo "✅ hop1=POST，hop2=GET（303 改写）"; PASS=$((PASS+1)); } \
  || { echo "❌ 方法改写错误：$HM1/$HM2"; FAIL=$((FAIL+1)); }
check "相对 Location 解析" '"nextUrl":"https://login.example.com/dashboard"' "$R"
HDR2=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['hops'][1]['send']['cookieHeader'])")
[ "$HDR2" = "sid=abc" ] && { echo "✅ hop2 携带 hop1 写入的 Cookie：$HDR2"; PASS=$((PASS+1)); } \
  || { echo "❌ hop2 Cookie 头异常：$HDR2"; FAIL=$((FAIL+1)); }
check "303 改写说明" "303 See Other" "$R"
check "末跳 200" '"status":200' "$R"
check "末跳无下一跳" '"nextUrl":null' "$R"
check "最终罐含 3 条" '"index":3' "$R"

echo "== RC2. 301 POST->GET；307 保留方法（GET 不被再改写） =="
post /api/reset '{}' >/dev/null
R=$(post /api/redirect-chain '{
  "startUrl":"https://a.example/form","method":"POST","topUrl":"https://a.example/",
  "steps":[{"status":301,"location":"/r1"},{"status":307,"location":"/r2"},{"status":200}]}')
check "链成功" '"ok":true' "$R"
M1=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['hops'][0]['method'])")
M2=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['hops'][1]['method'])")
M3=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['hops'][2]['method'])")
[ "$M1" = "POST" ] && [ "$M2" = "GET" ] && [ "$M3" = "GET" ] \
  && { echo "✅ 301 把 POST 改 GET，307 保持 GET（$M1/$M2/$M3）"; PASS=$((PASS+1)); } \
  || { echo "❌ 方法改写错误：$M1/$M2/$M3"; FAIL=$((FAIL+1)); }

echo "== RC3. 303 对 HEAD 保留 HEAD =="
R=$(post /api/redirect-chain '{
  "startUrl":"https://a.example/h","method":"HEAD","topUrl":"https://a.example/",
  "steps":[{"status":303,"location":"/r"},{"status":308,"location":"/r2"},{"status":200}]}')
H2=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['hops'][1]['method'])")
[ "$H2" = "HEAD" ] && { echo "✅ HEAD 经 303 保留"; PASS=$((PASS+1)); } \
  || { echo "❌ HEAD 应保留，实际 $H2"; FAIL=$((FAIL+1)); }

echo "== RC4. 预校验失败：罐保持不变 =="
post /api/reset '{}' >/dev/null
BEFORE=$(curl -s "$BASE/api/jar")
rc_expect_400() { # desc body
  local code
  code=$(curl -s -o /tmp/rc_resp.json -w '%{http_code}' -X POST "$BASE/api/redirect-chain" \
    -H 'Content-Type: application/json' -d "$2")
  if [ "$code" = "400" ] && grep -q '"ok":false' /tmp/rc_resp.json && grep -q '罐保持不变' /tmp/rc_resp.json; then
    echo "✅ $1 -> 400"; PASS=$((PASS+1));
  else echo "❌ $1 应 400，实际 $code：$(cat /tmp/rc_resp.json)"; FAIL=$((FAIL+1)); fi
}
rc_expect_400 "末跳不是 200" '{"startUrl":"https://a.com/","topUrl":"https://a.com/","steps":[{"status":302,"location":"/x"},{"status":301,"location":"/y"}]}'
rc_expect_400 "200 带 Location" '{"startUrl":"https://a.com/","topUrl":"https://a.com/","steps":[{"status":302,"location":"/x"},{"status":200,"location":"/y"}]}'
rc_expect_400 "中间 200" '{"startUrl":"https://a.com/","topUrl":"https://a.com/","steps":[{"status":200},{"status":200}]}'
rc_expect_400 "跳转缺 Location" '{"startUrl":"https://a.com/","topUrl":"https://a.com/","steps":[{"status":307},{"status":200}]}'
rc_expect_400 "非 http(s) Location" '{"startUrl":"https://a.com/","topUrl":"https://a.com/","steps":[{"status":302,"location":"mailto:x@y.com"},{"status":200}]}'
rc_expect_400 "起始 URL 非法" '{"startUrl":"not-a-url","topUrl":"https://a.com/","steps":[{"status":200}]}'
rc_expect_400 "缺 topUrl" '{"startUrl":"https://a.com/","steps":[{"status":200}]}'
rc_expect_400 "setCookies 非字符串数组" '{"startUrl":"https://a.com/","topUrl":"https://a.com/","steps":[{"status":200,"setCookies":[1,2]}]}'
rc_expect_400 "9 步超限" "$(python3 -c "import json;print(json.dumps({'startUrl':'https://a.com/','topUrl':'https://a.com/','steps':[{'status':302,'location':'/x'}]*8+[{'status':200}]}))")"
AFTER=$(curl -s "$BASE/api/jar")
[ "$BEFORE" = "$AFTER" ] && { echo "✅ 全部预校验失败后罐保持不变"; PASS=$((PASS+1)); } \
  || { echo "❌ 预校验失败改动了罐"; FAIL=$((FAIL+1)); }

echo "== RC5. 结构错误（server 层）也 400 =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/redirect-chain" \
  -H 'Content-Type: application/json' -d '{"startUrl":"https://a.com/","topUrl":"https://a.com/","steps":[]}')
[ "$code" = "400" ] && { echo "✅ 空 steps -> 400"; PASS=$((PASS+1)); } \
  || { echo "❌ 空 steps 应 400，实际 $code"; FAIL=$((FAIL+1)); }

echo "== RC6. 屏蔽第三方 + Partitioned 沿链沿用同一顶层 URL =="
post /api/reset '{}' >/dev/null
# 第 1 跳在跨站 tracker 响应：普通 Cookie 被拒、Partitioned 入罐；
# 302 跳回同站 shop（200 终态）-> 同站上下文下两个主机域不同，tracker 项均不发送。
# 为验证「跨站请求只发分区键匹配的 Partitioned 项」，终态落在 tracker 主机。
R=$(post /api/redirect-chain '{
  "startUrl":"https://tracker.vendor.com/pixel","topUrl":"https://shop.example.com/home",
  "blockThirdParty":true,
  "steps":[
    {"status":302,"location":"https://tracker.vendor.com/landing",
     "setCookies":["ch=1; Path=/; Secure; SameSite=None; Partitioned","trk=1; Path=/"]},
    {"status":200}]}')
check "链成功" '"ok":true' "$R"
check "跨站普通 Cookie 拒绝写入" '"action":"rejected"' "$R"
check "分区 cookie 正常入罐" '"action":"stored"' "$R"
# 末跳在跨站上下文（tracker ≠ 顶层 shop）：普通 cookie 被第三方屏蔽排除，
# 分区键匹配的 Partitioned 项仍发送
LAST_HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['hops'][-1]['send']['cookieHeader'])")
[ "$LAST_HDR" = "ch=1" ] && { echo "✅ 末跳仅发送分区键匹配的 Partitioned 项：$LAST_HDR"; PASS=$((PASS+1)); } \
  || { echo "❌ 末跳 Cookie 头异常：$LAST_HDR"; FAIL=$((FAIL+1)); }
# trk 在 hop1 即被第三方屏蔽拒绝，从未入罐：最终罐只剩分区 cookie ch=1
JAR_NAMES=$(curl -s "$BASE/api/jar" | python3 -c "import sys,json;print(','.join(sorted(c['name'] for c in json.load(sys.stdin)['cookies'])))")
[ "$JAR_NAMES" = "ch" ] && { echo "✅ 跨站普通 Cookie 未入罐，最终罐仅 $JAR_NAMES"; PASS=$((PASS+1)); } \
  || { echo "❌ 最终罐条目异常：$JAR_NAMES"; FAIL=$((FAIL+1)); }

# 罐中已存在的跨站普通 Cookie（如经 /api/store 先写入）在链请求中被排除、
# 分区键匹配的 Partitioned 项仍发送
post /api/reset '{}' >/dev/null
post /api/store '{"url":"https://tracker.vendor.com/","setCookie":"old=1; Path=/; Secure; SameSite=None"}' >/dev/null
R=$(post /api/redirect-chain '{
  "startUrl":"https://tracker.vendor.com/start","topUrl":"https://shop.example.com/home",
  "blockThirdParty":true,"steps":[{"status":200}]}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['hops'][0]['send']['cookieHeader'])")
EXC=$(echo "$R" | python3 -c "import sys,json;print('|'.join(i['detail'] for i in json.load(sys.stdin)['hops'][0]['send']['excluded']))")
[ "$HDR" = "" ] && echo "$EXC" | grep -q '屏蔽第三方 Cookie' \
  && { echo "✅ 链中跨站请求排除既有普通 Cookie（$EXC 节选）"; PASS=$((PASS+1)); } \
  || { echo "❌ 既有普通 Cookie 应被屏蔽：HDR=$HDR EXC=$EXC"; FAIL=$((FAIL+1)); }

post /api/reset '{}' >/dev/null
post /api/capacity '{"globalLimit":null,"domainLimits":{}}' >/dev/null

echo
echo "================================"
echo "通过 $PASS，失败 $FAIL"
[ "$FAIL" -eq 0 ]
