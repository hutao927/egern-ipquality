# 贡献与发布说明

## 发布新版本

改完 `src/` 之后按顺序执行：

```bash
npm run build     # 把 src/core.js 打包进 scripts/*.js
npm run check     # 打包一致性 + 全部 157 项检查
git add -A
git commit -m "描述这次改动"
git push
```

**`scripts/` 必须一起提交。** Egern 直接拉取这些文件，用户不会在本地跑打包器。

`npm run check` 会先重新打包并比对结果，如果 `scripts/` 与 `src/` 不一致会直接报错，
所以不会出现「改了 src 忘了 build」的情况。

## 改动落在哪里

| 想改什么 | 改哪个文件 |
| --- | --- |
| 数据源、评分算法、解锁探测逻辑 | `src/core.js` |
| 报告排版、参数解析 | `src/ipquality.js` |
| 小组件外观 | `src/ipquality-widget.js` |
| 变化监控行为 | `src/ipquality-net.js` |
| 节点对比 / 规则生成 | `src/ipquality-nodes.js` |
| 模块参数、安装方式 | `IPQuality.module.yaml` |

**永远不要直接编辑 `scripts/` 下的文件。** 它们是 `tools/bundle.mjs` 的产物，
下次打包就会被覆盖。`npm run check` 能检测出这种情况。

入口脚本里这段是生成的：

```js
/* ==== CORE:BEGIN ==== */
// 由 tools/bundle.mjs 从 src/core.js 生成，请勿手改
/* ==== CORE:END ==== */
```

## 新增一个解锁探测

在 `src/core.js` 的 `SERVICE_PROBES` 数组里加一项：

```js
{
  id: 'example',            // ONLY_SERVICES 里用的 id，全小写
  name: 'Example Service',  // 报告里显示的名字
  note: '流媒体',           // 分组标签
  async run({ ctx, options }) {
    const res = await httpGet(ctx, 'https://example.com/', { ...options, timeout: 10000 });
    if (!res.ok && !res.body) return { status: 'unknown', note: res.error || `HTTP ${res.status}` };
    // 用明确的字段判断，不要只看状态码
    if (/blocked-marker/.test(res.body)) return { status: 'no', region: '', type: 'Web', note: '地区受限' };
    return { status: 'yes', region: 'JP', type: 'Web', note: '' };
  },
},
```

三条约定：

1. **`status` 只能是 `yes` / `no` / `partial` / `unknown`。** 拿不准就返回
   `unknown` —— 探测失败绝不能冒充「被屏蔽」，这是这个项目最看重的一条。
2. **`unknown` 时不要在 `note` 里写「屏蔽」之类的措辞。**
3. **在 `tests/fixtures.json` 里加对应响应样本**，然后在
   `tests/run-tests.mjs` 加测试覆盖「解锁 / 屏蔽 / 未知」三种情况。

## 新增一个参数

1. 在入口脚本的 `readOptions()` 里用 `env()` / `envFlag()` / `envInt()` 读取
2. 在 `IPQuality.module.yaml` 的 `env_schema` 里声明（带 `name` 和 `default_value`）
3. 在该模块的 `scriptings[].env` 里转发

`validate-module.mjs` 会**静态检查**这三步是否都做了。这一步很关键：
参数名拼错在运行时是完全静默的（脚本只会悄悄退回默认值），
只有这个检查能抓出来。

## 更新解锁探测（服务改版时）

网页结构变了会导致探测返回 `unknown`。改 `src/core.js` 里对应 `run()` 的正则即可，
然后更新 `tests/fixtures.json` 里的样本。

## 许可

AGPL-3.0。提交的代码需沿用同一许可。
