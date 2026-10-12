/**
 * IP Quality Check for Egern — node comparison & rule generation
 * ---------------------------------------------------------------
 * Type: generic (run manually)
 *
 * Two jobs, chosen with MODE:
 *
 *   MODE=compare   Probe every policy in a policy group and rank them
 *                  by IP quality, so you can pick the best node
 *                  instead of the one with the lowest latency.
 *
 *   MODE=rules     Inspect the current egress and emit ready-to-paste
 *                  Egern rules that route the services your current
 *                  node cannot reach through a working policy.
 *
 * Group mode is sequential on purpose: probing several policies at
 * once makes them contend for the same tunnel and can cross results.
 *
 * This file is BUNDLED; see src/core.js and tools/bundle.mjs.
 *
 * License: AGPL-3.0. Upstream: https://github.com/xykt/IPQuality
 */

/* ==== CORE:BEGIN ==== */
/* ==== CORE:END ==== */

/* ===================================================================
 * Entry logic
 * =================================================================== */

function readOptions(ctx) {
  return {
    mode: env(ctx, 'MODE', 'compare').toLowerCase(),
    policies: env(ctx, 'POLICIES', '')
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    prefer: env(ctx, 'IP_VERSION', 'auto').toLowerCase(),
    targetPolicy: env(ctx, 'TARGET_POLICY', 'PROXY'),
    notify: envFlag(ctx, 'NOTIFY', true),
    nodeTimeout: envInt(ctx, 'NODE_TIMEOUT', 10000, 3000, 40000),
  };
}

/** MODE=compare — rank the configured policies. */
async function runCompare(ctx, opts) {
  if (opts.policies.length === 0) {
    return {
      error:
        '未配置 POLICIES。请在脚本的 env 中填写要对比的策略组或节点名称，用英文逗号分隔，例如：\n' +
        'POLICIES = 香港01,日本02,新加坡03',
    };
  }
  if (opts.policies.length > 12) {
    return { error: `一次最多对比 12 个节点（当前 ${opts.policies.length} 个），请分批测试。` };
  }

  const rows = await compareNodes(ctx, opts.policies, {
    prefer: opts.prefer,
    timeout: opts.nodeTimeout,
  });

  try {
    ctx.storage.setJSON(KEYS.nodeCompare, { at: new Date().toISOString(), rows });
  } catch {
    // best effort
  }

  const report = renderComparison(rows, `节点体检对比（${rows.length} 个）`);
  return { report, rows };
}

/** MODE=rules — generate routing rules from the current egress. */
async function runRules(ctx, opts) {
  const detected = await detectEgressIP(ctx, { prefer: opts.prefer });
  if (!detected) return { error: '无法检测出口 IP，请检查代理是否正常工作。' };

  const [signals, services] = await Promise.all([
    gatherIntelligence(ctx, detected.ip, {}),
    probeServices(ctx, { deadline: 15000 }),
  ]);
  if (!signals.ipApiCom && !signals.ipApiIs && !signals.ipInfo) {
    return { error: '数据源不可达，无法生成规则。' };
  }

  const model = {
    ip: detected.ip,
    family: detected.family,
    signals,
    score: computeRiskScore(signals),
    ipType: classifyIPType(signals.ipApiIs || signals.ipApiCom, signals.ipInfo),
    usageType: classifyUsageType(signals),
    services,
    mail: [],
    cloudflare: signals.cloudflare,
    meta: { elapsed: '—', scriptName: ctx.script.name, truncated: false },
  };

  const generated = generateRules(model, { targetPolicy: opts.targetPolicy });

  const lines = [];
  lines.push('# 🧭 分流规则建议');
  lines.push('');
  const primary = signals.ipApiCom || signals.ipApiIs || signals.ipInfo;
  lines.push(`当前出口：${maskIP(detected.ip, false)} · ${flagEmoji(primary.country)} ${primary.country || '??'} · ${model.usageType.label}`);
  lines.push('');
  lines.push(`**目标策略：${opts.targetPolicy}**`);
  lines.push('');

  if (generated.notes.length > 0) {
    lines.push('## 生成依据');
    lines.push('');
    for (const note of generated.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## 规则（粘贴到 Profile.yaml 的 rules 段）');
  lines.push('');
  lines.push('```yaml');
  lines.push(generated.yaml);
  lines.push('```');
  lines.push('');
  lines.push('> 规则按顺序匹配，请把更精确的规则放在前面。生成的是**建议**，导入前请自行确认策略名存在。');

  try {
    ctx.storage.setJSON(KEYS.lastRules, { at: new Date().toISOString(), yaml: generated.yaml });
  } catch {
    // best effort
  }

  return { report: lines.join('\n'), rules: generated };
}

export default async function (ctx) {
  const opts = readOptions(ctx);

  try {
    const result = opts.mode === 'rules' ? await runRules(ctx, opts) : await runCompare(ctx, opts);

    if (result.error) {
      if (opts.notify) ctx.notify({ title: '❌ 无法完成', body: result.error, sound: true });
      return { type: 'text', text: result.error };
    }

    if (opts.notify) {
      const title = opts.mode === 'rules' ? '🧭 规则建议已生成' : '🔍 节点对比完成';
      const preview =
        opts.mode === 'rules'
          ? result.rules.rules.slice(0, 4).map((r) => `${r.type}: ${r.match}`).join('\n')
          : `已对比 ${result.rows.length} 个节点，结果已复制到剪贴板。`;
      ctx.notify({
        title,
        body: result.report.length > 400 ? preview : result.report,
        sound: false,
        action: { type: 'clipboard', text: result.report },
      });
    }

    return { type: 'text', text: result.report };
  } catch (error) {
    const message = str((error && error.message) || error);
    if (opts.notify) ctx.notify({ title: '❌ 脚本执行失败', body: message, sound: true });
    return { type: 'text', text: `执行失败：${message}` };
  }
}
