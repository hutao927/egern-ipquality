# IP 质量体检 — Egern 插件

把 [xykt/IPQuality](https://github.com/xykt/IPQuality) 移植到 Egern 的脚本套件。
检测当前代理出口 IP 的**基础信息、风险评分、风险因子、流媒体/AI 解锁状态**，
并在此之上加了三个原版没有的能力：**出口 IP 变化监控**、**多节点批量体检对比**、
**分流规则自动生成**。

> **不需要托管。** 四个脚本都是自包含的单文件，直接贴进 Egern 即可使用，
> 不依赖 GitHub 仓库、不需要 raw 链接。见下面「方式 A」。

---

## 目录

- [安装](#安装)
- [四个脚本各做什么](#四个脚本各做什么)
- [小组件](#小组件)
- [参数说明](#参数说明)
- [相比原版提升了什么](#相比原版提升了什么)
- [准确率是怎么保证的](#准确率是怎么保证的)
- [功能对照表](#功能对照表)
- [开发](#开发)
- [已知限制](#已知限制)
- [许可](#许可)

---

## 安装

### 方式 A：纯本地（推荐，零托管）

四个脚本已经打包成**自包含单文件**，彼此不依赖，可以单独使用。

1. 打开 Egern → **工具 → 脚本** → 右上角 `+`
2. 名称填 `IP 质量体检`，类型选 **generic**
3. 把 `scripts/ipquality.js` 的**全部内容**粘贴进脚本体
4. 保存后即可在脚本列表里手动运行

想用小组件的话，再用同样方式新建一个 `ipquality-widget`，
把 `scripts/ipquality-widget.js` 的内容粘进去，然后到桌面添加小组件、
选择 `ipquality-widget`。

> 注意：小组件要先手动运行一次 `ipquality` 建立缓存，否则会显示「暂无数据」。

**想同时用节点对比和 IP 变化监控**，就照做再加两个脚本：
`scripts/ipquality-nodes.js`（generic）和 `scripts/ipquality-net.js`（network）。
只用报告的话不需要它们。

### 方式 B：模块安装（一键更新）

如果你愿意把仓库放到 GitHub：

1. 编辑 `IPQuality.module.yaml`，把 `SCRIPT_BASE` 换成你的仓库地址：

   ```yaml
   compat_arguments:
     SCRIPT_BASE: "https://raw.githubusercontent.com/你的用户名/egern-ipquality/main"
   ```

2. Egern → **工具 → 模块** → `+` → 粘贴该文件的 raw 链接
3. 打开模块设置页填写参数

模块会把四个脚本 + 小组件 + 每日定时任务一次性装好，
以后改仓库内容即可自动更新。

### 方式 C：本地文件夹 + 模块

Egern 的 `script_url` 支持本地路径，所以也可以把 scripts 放进
Egern 的文件目录，然后把模块里的 `SCRIPT_BASE` 改成本地路径：

```yaml
compat_arguments:
  SCRIPT_BASE: "/Egern/IPQuality"
```

脚本文件放在 `/Egern/IPQuality/scripts/` 下即可。

---

## 四个脚本各做什么

| 脚本 | 类型 | 作用 |
| --- | --- | --- |
| **ipquality.js** | generic | 完整体检报告：六模块 Markdown、风险评分、逐服务解锁判定。也可被小组件调用。 |
| **ipquality-widget.js** | generic | 只负责小组件渲染。缓存新鲜时零网络请求。 |
| **ipquality-net.js** | network | 出口 IP 变化监控。切 Wi-Fi / 蜂窝 / VPN 时触发，只在**真的变了**时通知。 |
| **ipquality-nodes.js** | generic | 多节点批量对比（`MODE=compare`）与分流规则生成（`MODE=rules`）。 |

### 出口 IP 变化监控

手机上一个实际的问题是「为什么我的风险画像变了」——通常答案是「代理换节点了」。
这个脚本就是回答它的，而且很便宜：一次 IP 回显 + 一次地理查询，
不像完整体检那样打十几个 API。

- 只在 IP / 地区 / ASN / 组织 / 类型**真的变化**时通知，否则完全安静
- 从家宽切到机房 IP 会额外警告（这类 IP 很多服务不友好）
- 想确认监控在运行，开 `NOTIFY_ON_STABLE`
- 开 `FULL_ON_CHANGE` 则变化后自动补一次完整体检

### 多节点批量体检对比

`POLICIES` 填策略组或节点名，用英文逗号分隔（最多 12 个）。

它不是按延迟排序，而是按**IP 质量**排序：

> 可用优先 → 住宅/ISP IP 优先 → 风险分低者优先

因为一个延迟 20ms 的机房 IP 往往不如延迟 80ms 的家宽 IP 好用 ——
流媒体、注册、支付都会挑 IP 类型。

**多个节点是串行检测的**，这是刻意的：同时让多个策略走同一个隧道
会互相干扰、结果串味。

### 分流规则自动生成

`MODE=rules` 会先体检当前出口，然后针对**当前被屏蔽的服务**
生成 Egern 规则，把这些服务的域名指向你指定的策略：

```yaml
rules:
  - domain_suffix:
      match: openai.com
      policy: 日本节点
  - geoip:
      match: CN
      policy: DIRECT
      no_resolve: true
```

复制粘贴前请确认 `TARGET_POLICY` 是你配置里**真实存在**的策略名。

---

## 小组件

支持全部 7 种尺寸：

| 尺寸 | 显示内容 |
| --- | --- |
| `systemSmall` | 风险分、地区、解锁/屏蔽计数 |
| `systemMedium` | 风险分 + ASN / 组织 / 城市 / 类型 |
| `systemLarge` / `systemExtraLarge` | 上面之外再加解锁与屏蔽服务数 |
| `accessoryCircular` | 锁屏圆形：分数 |
| `accessoryRectangular` | 锁屏矩形：分数 + 地区 + 风险等级 |
| `accessoryInline` | 锁屏单行：`🌐 12/100 低风险` |

**缓存策略**：小组件渲染很频繁（15–30 分钟一次，加上 iOS 自己的调度）。
每次都跑完整检测会又慢又浪费公共 API 配额，所以：

1. 缓存新鲜（默认 30 分钟内）→ 直接渲染，**零网络请求**
2. 缓存过期 → 做一次轻量刷新（1 个 IP 回显 + 2 个数据库）
3. 轻量刷新失败 → 回退到旧缓存，并标注「（缓存）」
4. 完全没有缓存 → 提示先手动运行一次

---

## 参数说明

在脚本的 `env` 中设置（模块安装则用模块设置页）。

### 通用

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `IP_VERSION` | `auto` | `auto` / `4` / `6`。auto 会同时尝试两栈并取最快响应的 |
| `POLICY` | 空 | 指定检测走的策略组。留空跟随当前规则 |
| `SHOW_FULL_IP` | `false` | 关闭时打码为 `203.0.*.*` |
| `NOTIFY` | `true` | 完成后推送通知，点按复制完整报告 |
| `OUTPUT` | `markdown` | `markdown` 可读报告 / `json` 结构化数据 |

### 报告

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `SKIP_SERVICES` | `false` | 跳过流媒体/AI 检测（明显更快） |
| `SKIP_MAIL` | `false` | 跳过邮局可达性检测 |
| `ONLY_SERVICES` | 空 | 只测指定服务，如 `chatgpt,netflix`。可选：`chatgpt` `netflix` `youtube` `disney` `primevideo` `tiktok` `googleplay` `reddit` |
| `SERVICE_TIMEOUT` | `15000` | 单个服务探测超时（毫秒） |
| `TRACK_HISTORY` | `true` | 记录出口 IP 历史 |

### 小组件

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `REFRESH_MINUTES` | `30` | 缓存新鲜期（分钟） |
| `AUTO_REFRESH` | `true` | 缓存过期时是否允许小组件自行轻量检测 |

### IP 变化监控

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `NOTIFY_ON_CHANGE` | `true` | 变化时通知 |
| `NOTIFY_ON_STABLE` | `false` | 没变化也通知（确认监控在跑） |
| `FULL_ON_CHANGE` | `false` | 变化后补一次完整体检 |
| `MAX_HISTORY` | `20` | 历史记录条数上限 |

### 节点工具

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `MODE` | `compare` | `compare` 节点对比 / `rules` 规则生成 |
| `POLICIES` | 空 | 待对比策略，逗号分隔，最多 12 个 |
| `NODE_TIMEOUT` | `10000` | 单节点超时（毫秒） |
| `TARGET_POLICY` | `PROXY` | 规则指向的策略名 |

### 可选 API Key

**全部可选**。不填也能完整运行，只是参与评分的数据库会少一些。

| 参数 | 效果 |
| --- | --- |
| `IPINFO_TOKEN` | ipinfo 返回更完整字段与更高配额 |
| `ABUSEIPDB_KEY` | 加入 AbuseIPDB 滥用置信度评分 |
| `SCAMALYTICS_USER` + `SCAMALYTICS_KEY` | 加入 Scamalytics 欺诈分（需同时填） |
| `IPQS_KEY` | 加入 IPQualityScore 欺诈分 |
| `IPREGISTRY_KEY` | 加入 ipregistry 安全标记 |

不填任何 Key 时的免费数据源：`ip-api.com`、`api.ipapi.is`、`ipinfo.io`（无 token 的免费档）、Cloudflare `cdn-cgi/trace`。

---

## 相比原版提升了什么

### 1. 解锁检测从「猜」改成「实测」

原版是 bash + curl，逻辑直白但对页面结构变化很脆弱。移植版**照搬了
[lmc999/RegionRestrictionCheck](https://github.com/lmc999/RegionRestrictionCheck)
的真实探测逻辑**——它和 IPQuality 同源，但把每个服务真正调用的接口写清楚了：

| 服务 | 检测方式 |
| --- | --- |
| **ChatGPT** | Cloudflare `cdn-cgi/trace` 的 `loc` 字段，对照已知受限地区表 |
| **Netflix** | 同时探测**两个**原创剧集页（LEGO Ninjago / Breaking Bad），按 `Oh no!` 出现个数判定——**全解锁 / 部分受限 / 全部屏蔽**三态 |
| **YouTube Premium** | 读 `INNERTUBE_CONTEXT_GL` 取地区；`www.google.cn` 重定向判死；`ad-free` 字样判活 |
| **Disney+** | 完整走**设备断言三步握手**：`/devices` 取 assertion → `/token` 取 refresh_token → GraphQL 读 `countryCode` 与 `inSupportedLocation` |
| **PrimeVideo** | 读 `currentTerritory`，`isServiceRestricted` 判死 |
| **TikTok** | Cloudflare trace 的 `loc` |
| **Google Play** | 解析商店页地区节点 |
| **Reddit** | 按 HTTP 状态码判定（403/451 = 屏蔽） |

**关键改进是区分「被屏蔽」和「没测出来」。** 探测失败（超时、页面改版）
一律标记为 ❔ 未知，绝不冒充「被屏蔽」——报告里会明确写「不代表被屏蔽」。
这类误报是同类工具最常见的坑。

### 2. 风险评分

多个数据库各给 0–100 分，综合分是：

```
综合分 = 平均分 × 0.45 + 最高分 × 0.55
```

**刻意偏向最坏信号**。因为一个数据库非常确信地判「Tor 出口」，
不该被其他几个安静数据库平均掉。

等级：`<20 极低` `<40 低` `<60 中` `<80 高` `≥80 极高`。

### 3. 出口 IP 变化监控

见上文。原版是一次性报告，这是手机场景下真正长期有用的东西。

### 4. 多节点批量对比

见上文。把「哪个节点最好」从看延迟变成看 IP 质量。

### 5. 分流规则自动生成

见上文。从「知道当前节点不行」到「直接生成绕过规则」。

### 6. 小组件

原版是终端脚本，没有常驻展示。移植版有 7 种尺寸的小组件 + 锁屏组件。

### 7. 结构上的改进

- **单文件自包含**：四个脚本各自完整，不需要模块或托管
- **共享核心**：`src/core.js` 是唯一事实来源，`tools/bundle.mjs` 打包进各入口脚本，
  消除了三份重复逻辑
- **157 项自动化检查**：50 项行为测试 + 74 项模块校验 + 33 项小组件 DSL 校验

---

## 准确率是怎么保证的

除了上面的真实接口探测，还有这些：

**并发 + 竞速。** 出口 IP 检测同时打多个回显服务取最快响应，
既提升速度也降低单点失败影响。

**有界并发。** 服务探测 6 个一批，避免打爆对端限流。

**分级超时。** 每一层（脚本、单次请求、单个探测）都有独立超时，
任何一层挂掉都不会拖死整个报告。

**部分成功也能出报告。** 12 个数据源挂了 10 个，剩下 2 个照样出报告，
并在页脚列明实际用到的数据源。

**探测定义可测试。** `tests/fixtures.json` 存了每个服务的真实响应样本，
50 项行为测试覆盖「解锁 / 屏蔽 / 部分 / 未知」四态，
包括 Disney+ 三步握手、Netflix 双剧集、YouTube 重定向等边界情况。

---

## 功能对照表

原版是 bash，很多能力依赖 Linux 用户态工具，iOS 沙箱里**做不到**。
这里如实列出，不做粉饰：

| 原版功能 | 移植状态 | 说明 |
| --- | --- | --- |
| 出口 IP 基础信息 | ✅ 完整 | 并发竞速多个回显源 |
| 多库风险评分 | ✅ 增强 | 加权算法偏向最坏信号 |
| 风险因子矩阵 | ✅ 完整 | 按数据库来源逐项列出 |
| 流媒体 / AI 解锁 | ✅ **增强** | 真实接口探测 + 三态判定 |
| JSON 输出 | ✅ 完整 | 对齐原版 `-j` 字段 |
| 微信 / Telegram 推送 | ⚠️ 替代 | 改用 Egern 原生通知 + 点击复制报告 |
| 25 端口 SMTP 直连测试 | ❌ 不可行 | iOS 沙箱无原始套接字，改为 **HTTPS 可达性替代检测**，报告中已注明 |
| 12 家邮箱 SMTP 探针 | ❌ 不可行 | 同上 |
| 400+ DNSBL 查询（`dig`） | ❌ 不可行 | 沙箱无 DNS TXT 查询能力；已由 ipapi.is / AbuseIPDB 等库的滥用标记覆盖 |
| `-i eth0` 指定网卡 | ❌ 不可行 | 沙箱无网卡枚举 |
| 本地端口连通性扫描 | ❌ 不可行 | 无原始套接字 |
| 出口 IP 变化监控 | ➕ **新增** | 原版没有 |
| 多节点批量对比 | ➕ **新增** | 原版没有 |
| 分流规则生成 | ➕ **新增** | 原版没有 |
| 小组件 / 锁屏组件 | ➕ **新增** | 原版没有 |

> 邮局那部分要特别说明：它**不是** SMTP 测试，只是 HTTPS 可达性检查。
> 报告里每一节都写明了检测方式，不会让人误以为是原版那个测试。

---

## 开发

需要 Node.js 18+（仅用于构建和测试，运行脚本不需要）。

```bash
npm run build     # 把 src/core.js 打包进 scripts/*.js
npm run check     # 打包一致性 + 全部测试
npm test          # 只跑行为测试
npm run validate  # 模块 YAML + 小组件 DSL 校验
```

### 结构

```
src/core.js              唯一事实来源：provider、评分、探测、工具函数
src/ipquality.js         入口：完整体检
src/ipquality-widget.js  入口：小组件
src/ipquality-net.js     入口：IP 变化监控
src/ipquality-nodes.js   入口：节点对比 / 规则生成
scripts/*.js             打包产物 —— 直接安装这些文件
tools/bundle.mjs         打包器
tools/check.mjs          一键全量检查
IPQuality.module.yaml    模块定义（可选安装方式）
tests/                   测试与校验
```

**只改 `src/`，然后跑 `npm run build`。** `scripts/` 是生成物，
直接改会在下次打包时被覆盖——`npm run check` 会检测出这种情况。

入口脚本里这段是生成的，不要手改：

```js
/* ==== CORE:BEGIN ==== */
// ...由 tools/bundle.mjs 生成...
/* ==== CORE:END ==== */
```

### 测试覆盖

| 套件 | 检查项 | 内容 |
| --- | --- | --- |
| `run-tests.mjs` | 50 | 报告六模块、服务四态判定、IP 变化、参数开关、容错、小组件缓存策略、节点排序、规则生成 |
| `validate-module.mjs` | 74 | YAML 合法性、占位符声明、脚本文件存在、**脚本读的 env 必须在模块里声明并转发** |
| `validate-widget-dsl.mjs` | 33 | 7 种尺寸 × 冷/热/空/过期状态，全部 DSL 元素与属性对照官方文档 |

`validate-module.mjs` 里那条 env 检查很实用：参数名拼错在运行时是静默的
（脚本只是退回默认值），这个检查能静态抓出来——开发时已经靠它抓到了
两个真实问题。

---

## 已知限制

- **无法在本机验证真实 API 行为。** 开发环境没有出网能力，
  所有 provider 和探测逻辑都是**基于文档和上游源码推导**的，
  没有对真实接口跑过。请务必在设备上先手动跑一次确认。
  如果某个服务判定异常，多半是页面结构变了，改 `src/core.js` 里对应的正则即可。
- **网页结构变化会导致探测失效。** 这是所有基于页面解析的工具的通病。
  失效时表现为 ❔ 未知（而不是误报屏蔽）。
- **免费 API 有速率限制。** 短时间内反复运行可能被限流，
  表现为部分数据库缺失。建议配合缓存机制使用。
- **节点对比是串行的**，12 个节点会比较慢（每个约 2–5 秒）。
- **`geoip: CN` 规则**假设国内流量应直连，如果你的场景不同请自行调整。

---

## 许可

**AGPL-3.0**。这是 [xykt/IPQuality](https://github.com/xykt/IPQuality)（AGPL-3.0）
的衍生作品，解锁检测逻辑另改编自
[lmc999/RegionRestrictionCheck](https://github.com/lmc999/RegionRestrictionCheck)（GPL-3.0）。
沿用同一许可。
