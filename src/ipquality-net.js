/**
 * IP Quality Check for Egern — IP change monitor
 * ---------------------------------------------------------------
 * Type: network (runs on Wi-Fi / cellular / VPN changes)
 *
 * Why this exists
 * ---------------
 * The upstream bash script is a one-shot report. The question people
 * actually care about on a phone is: "why did my risk profile change?"
 * Usually the answer is "the proxy switched nodes". This script watches
 * the egress IP and tells you exactly what changed, without running a
 * full multi-database report every time.
 *
 * Behaviour
 * ---------
 *   - Cheap: one IP echo plus a single geo lookup.
 *   - Silent when nothing changed (configurable).
 *   - Writes to the same history the main report uses, so both agree.
 *   - Re-runs the full report only when the IP actually changed and
 *     FULL_ON_CHANGE is enabled.
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

function readNetOptions(ctx) {
  return {
    policy: env(ctx, 'POLICY', '') || undefined,
    prefer: env(ctx, 'IP_VERSION', 'auto').toLowerCase(),
    notifyOnChange: envFlag(ctx, 'NOTIFY_ON_CHANGE', true),
    notifyOnStable: envFlag(ctx, 'NOTIFY_ON_STABLE', false),
    fullOnChange: envFlag(ctx, 'FULL_ON_CHANGE', false),
    maxHistory: envInt(ctx, 'MAX_HISTORY', 20, 2, 200),
  };
}

/** Compact probe: egress IP + one geo lookup. */
async function quickSnapshot(ctx, opts) {
  const detected = await detectEgressIP(ctx, { policy: opts.policy, prefer: opts.prefer });
  if (!detected) return null;

  const [ipApiIs, ipApiCom] = await Promise.all([
    withTimeout(fetchIpApiIs(ctx, detected.ip, { policy: opts.policy }), 10000),
    withTimeout(fetchIpApiCom(ctx, detected.ip, { policy: opts.policy }), 9000),
  ]);
  if (!ipApiIs && !ipApiCom) return null;

  const primary = ipApiCom || ipApiIs;
  const score = computeRiskScore({ ipApiCom, ipApiIs });
  return {
    ip: detected.ip,
    family: detected.family,
    country: str(primary.country),
    countryName: str(primary.countryName),
    city: str(primary.city),
    asn: primary.asn ?? null,
    org: str(primary.isp) || str(primary.org),
    hosting: ipApiIs ? ipApiIs.isDatacenter : !!(ipApiCom && ipApiCom.isHosting),
    proxy: ipApiIs ? ipApiIs.isProxy || ipApiIs.isVPN || ipApiIs.isTor : !!(ipApiCom && ipApiCom.isProxy),
    score: score.total,
    level: score.level,
    at: new Date().toISOString(),
  };
}

/** Compare two snapshots into a change description. */
function diffSnapshots(previous, current) {
  if (!previous) return { changed: true, first: true, fields: [], previous: null, current };
  const fields = [];
  if (previous.ip !== current.ip) fields.push({ key: 'IP', from: previous.ip, to: current.ip });
  if (previous.country !== current.country) {
    fields.push({ key: '地区', from: previous.country || '未知', to: current.country || '未知' });
  }
  if (previous.asn !== current.asn) {
    fields.push({
      key: 'ASN',
      from: previous.asn ? `AS${previous.asn}` : '未知',
      to: current.asn ? `AS${current.asn}` : '未知',
    });
  }
  if (previous.org !== current.org) {
    fields.push({ key: '组织', from: previous.org || '未知', to: current.org || '未知' });
  }
  // `hosting` is only meaningful when BOTH sides recorded it. Older
  // history entries (or ones written by the main report) may omit it;
  // comparing against `undefined` would report a phantom type change on
  // an unchanged IP, so undefined is treated as "not comparable".
  if (
    typeof previous.hosting === 'boolean' &&
    typeof current.hosting === 'boolean' &&
    previous.hosting !== current.hosting
  ) {
    fields.push({
      key: '类型',
      from: previous.hosting ? '机房' : '住宅/ISP',
      to: current.hosting ? '机房' : '住宅/ISP',
    });
  }
  const scoreDelta =
    previous.score !== null && current.score !== null ? current.score - previous.score : null;
  if (scoreDelta !== null && Math.abs(scoreDelta) >= 10) {
    fields.push({
      key: '风险分',
      from: String(previous.score),
      to: `${current.score} (${scoreDelta > 0 ? '+' : ''}${scoreDelta})`,
    });
  }
  return { changed: fields.length > 0, first: false, fields, previous, current, scoreDelta };
}

/** Render the change notification body. */
function renderChangeBody(diff) {
  const lines = [];
  if (diff.first) {
    lines.push('首次记录出口 IP');
    lines.push('');
  }
  for (const field of diff.fields) {
    lines.push(`${field.key}：${field.from} → ${field.to}`);
  }
  const c = diff.current;
  lines.push('');
  lines.push(`当前：${maskIP(c.ip, false)} · ${flagEmoji(c.country)} ${c.country || '??'} · ${c.hosting ? '机房' : '住宅/ISP'}`);
  if (c.score !== null) {
    lines.push(`风险分：${riskEmoji(c.level)} ${c.score}/100（${riskLevelCN(c.level)}）`);
  }
  if (c.hosting && !diff.previous?.hosting) {
    lines.push('');
    lines.push('⚠️ 已切换到机房 IP，部分流媒体与注册类服务可能受限。');
  }
  return lines.join('\n');
}

export default async function (ctx) {
  const opts = readNetOptions(ctx);

  try {
    const current = await quickSnapshot(ctx, opts);
    if (!current) {
      if (opts.notifyOnChange) {
        ctx.notify({
          title: '⚠️ IP 监控未能完成',
          body: '网络变化后无法检测出口 IP，请检查代理状态。',
          sound: false,
        });
      }
      return { type: 'text', text: 'IP 监控：检测失败' };
    }

    // Compare against the newest stored record.
    let history = getIPHistory(ctx).reverse();
    const previous = history.length > 0 ? history[history.length - 1] : null;
    const diff = diffSnapshots(previous, current);

    if (diff.changed) {
      const record = {
        ip: current.ip,
        at: current.at,
        country: current.country,
        asn: current.asn,
        org: current.org,
        score: current.score,
        level: current.level,
        // Recorded so later comparisons can detect a datacenter switch.
        hosting: current.hosting,
      };
      history.push(record);
      if (history.length > opts.maxHistory) history = history.slice(-opts.maxHistory);
      try {
        ctx.storage.setJSON(KEYS.ipHistory, history);
      } catch {
        // best effort
      }
    }

    // Notify only when it matters.
    const shouldNotify = diff.changed ? opts.notifyOnChange : opts.notifyOnStable;
    if (shouldNotify && !diff.first) {
      const title = diff.fields.length > 0 ? '🔄 出口 IP 已变化' : 'ℹ️ 出口 IP 无变化';
      ctx.notify({
        title,
        subtitle: `${flagEmoji(current.country)} ${current.country || '??'} · ${current.hosting ? '机房' : '住宅/ISP'}`,
        body: renderChangeBody(diff),
        sound: diff.changed,
      });
    }

    // Optionally run the full report so history and the widget stay rich.
    if (opts.fullOnChange && diff.changed && !diff.first) {
      try {
        const full = await runFullReport(ctx, opts);
        if (full) ctx.notify({ title: '📋 完整体检已完成', body: full, sound: false });
      } catch {
        // The monitor's job is done; a failed deep dive is non-fatal.
      }
    }

    return {
      type: 'text',
      text: diff.changed
        ? `IP 变化：${diff.fields.map((f) => `${f.key} ${f.from}→${f.to}`).join('，') || '已更新记录'}`
        : 'IP 无变化',
    };
  } catch (error) {
    return { type: 'text', text: `IP 监控失败：${str((error && error.message) || error)}` };
  }
}

/** Deep probe used when FULL_ON_CHANGE fires. */
async function runFullReport(ctx, opts) {
  const detected = await detectEgressIP(ctx, { policy: opts.policy, prefer: opts.prefer });
  if (!detected) return null;

  const [signals, services] = await Promise.all([
    gatherIntelligence(ctx, detected.ip, { policy: opts.policy }),
    probeServices(ctx, { policy: opts.policy, deadline: 15000 }),
  ]);
  if (!signals.ipApiCom && !signals.ipApiIs && !signals.ipInfo) return null;

  const score = computeRiskScore(signals);
  return (
    `${flagEmoji(signals.ipApiCom?.country)} ${signals.ipApiCom?.countryName || ''} · ` +
    `${riskEmoji(score.level)} ${score.total ?? 'N/A'}/100 · ` +
    `解锁 ${services.filter((s) => s.status === 'yes').length}/${services.length}`
  );
}
