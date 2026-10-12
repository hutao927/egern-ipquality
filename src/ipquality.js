/**
 * IP Quality Check for Egern — main entry
 * ---------------------------------------------------------------
 * Run: Tools -> Scripts -> ipquality -> Run
 *
 * Produces the full six-module report, sends a notification whose body
 * is also copied to the clipboard, records the egress IP in history,
 * and refreshes the widget cache.
 *
 * This file is BUNDLED: the region between the CORE markers is
 * generated from src/core.js by tools/bundle.mjs. Edit the core there
 * and re-run the bundler — do not hand-edit the generated block.
 *
 * Install without hosting: paste this whole file into
 * Tools -> Scripts -> + -> Local file, or keep it in a Git repo.
 *
 * License: AGPL-3.0. Upstream: https://github.com/xykt/IPQuality
 * Service detection logic adapted from lmc999/RegionRestrictionCheck.
 */

/* ==== CORE:BEGIN ==== */
/* ==== CORE:END ==== */

/* ===================================================================
 * Entry logic
 * =================================================================== */

/** Options parsed from ctx.env, shared by report and widget runs. */
function readOptions(ctx) {
  return {
    showFull: envFlag(ctx, 'SHOW_FULL_IP', false),
    policy: env(ctx, 'POLICY', '') || undefined,
    prefer: env(ctx, 'IP_VERSION', 'auto').toLowerCase(),
    skipServices: envFlag(ctx, 'SKIP_SERVICES', false),
    skipMail: envFlag(ctx, 'SKIP_MAIL', false),
    onlyServices: env(ctx, 'ONLY_SERVICES', ''),
    trackHistory: envFlag(ctx, 'TRACK_HISTORY', true),
    outputFormat: env(ctx, 'OUTPUT', 'markdown').toLowerCase(),
    notifyResult: envFlag(ctx, 'NOTIFY', true),
    serviceDeadline: envInt(ctx, 'SERVICE_TIMEOUT', 15000, 3000, 40000),
  };
}

/** Parse the ONLY_SERVICES csv into probe ids (empty means all). */
function parseServiceIds(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Run the full check and return the model. */
async function buildModel(ctx, opts, scriptName) {
  const started = Date.now();

  const detected = await detectEgressIP(ctx, {
    policy: opts.policy,
    prefer: opts.prefer,
  });
  if (!detected) return { error: 'no-ip' };

  const { ip, family } = detected;

  const ids = parseServiceIds(opts.onlyServices);
  const servicesPromise = opts.skipServices
    ? Promise.resolve([])
    : probeServices(ctx, {
        policy: opts.policy,
        ids: ids.length > 0 ? ids : undefined,
        deadline: opts.serviceDeadline,
      });
  const mailPromise = opts.skipMail
    ? Promise.resolve([])
    : probeMailProviders(ctx, { policy: opts.policy });

  const [signals, services, mail] = await Promise.all([
    gatherIntelligence(ctx, ip, { policy: opts.policy, prefer: opts.prefer }),
    servicesPromise,
    mailPromise,
  ]);

  if (!signals.ipApiCom && !signals.ipApiIs && !signals.ipInfo) {
    return { error: 'no-data' };
  }

  const score = computeRiskScore(signals);
  const ipType = classifyIPType(signals.ipApiIs || signals.ipApiCom, signals.ipInfo);
  const usageType = classifyUsageType(signals);

  const model = {
    ip,
    family,
    signals,
    score,
    ipType,
    usageType,
    services,
    mail,
    cloudflare: signals.cloudflare,
    meta: {
      elapsed: `${((Date.now() - started) / 1000).toFixed(1)}s`,
      scriptName,
      truncated: false,
    },
  };

  if (opts.trackHistory) {
    model.ipChange = trackIPChange(ctx, model);
  }
  return model;
}

/** Persist the model so the widget can render without network access. */
function cacheModel(ctx, model, widgetTree) {
  try {
    const primary = model.signals.ipApiCom || model.signals.ipApiIs || model.signals.ipInfo || {};
    ctx.storage.setJSON(KEYS.last, {
      summary:
        `${maskIP(model.ip, false)} · ${model.score.total ?? 'N/A'}/100 ` +
        `${riskLevelCN(model.score.level)} · ${str(primary.country) || '??'}`,
      at: new Date().toISOString(),
      model,
      widget: widgetTree,
    });
  } catch {
    // Cache is best-effort; never fail a report because of storage.
  }
}

/** Keep the notification body within a sane length. */
function trimForNotification(report) {
  const LIMIT = 1800;
  if (report.length <= LIMIT) return { text: report, truncated: false };
  const clipped = report.slice(0, LIMIT);
  const lastBreak = clipped.lastIndexOf('\n## ');
  const text = lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped;
  return {
    text: `${text}\n\n…报告较长，完整内容已复制到剪贴板（点按通知复制）。`,
    truncated: true,
  };
}

/** Uniform failure payload for widget and generic contexts. */
function failResult(ctx, widget, title, body) {
  if (widget) {
    return {
      type: 'widget',
      padding: 12,
      backgroundColor: '#1A1A2E',
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 6,
          children: [
            { type: 'image', src: 'sf-symbol:exclamationmark.triangle.fill', width: 14, height: 14, color: '#F87171' },
            { type: 'text', text: title, font: { size: 'caption1', weight: 'semibold' }, textColor: '#F87171' },
          ],
        },
        { type: 'text', text: body, font: { size: 'caption2' }, textColor: '#FFFFFF99', maxLines: 3, minScale: 0.7 },
      ],
    };
  }
  ctx.notify({ title: `❌ ${title}`, body, sound: true });
  return { type: 'text', text: `${title}\n\n${body}` };
}

export default async function (ctx) {
  const widget = isWidget(ctx);
  const opts = readOptions(ctx);

  try {
    const model = await buildModel(ctx, opts, ctx.script.name);

    if (model.error === 'no-ip') {
      const cached = safeGetCache(ctx);
      if (widget && cached) return renderWidgetFromModel(ctx, cached.model, cached.at, false);
      // Even in text mode, a previous successful result is more useful
      // than a bare error.
      const detail = cached
        ? `所有 IP 回显服务均不可达，请检查代理是否正常工作。\n\n上次成功结果：${cached.summary}`
        : '所有 IP 回显服务均不可达，请检查代理是否正常工作。';
      return failResult(ctx, widget, '无法检测出口 IP', detail);
    }
    if (model.error === 'no-data') {
      const cached = safeGetCache(ctx);
      if (widget && cached) return renderWidgetFromModel(ctx, cached.model, cached.at, false);
      if (cached) {
        return failResult(ctx, widget, '数据源不可达', `上次成功结果：${cached.summary}`);
      }
      return failResult(ctx, widget, '数据源不可达', '所有地理位置数据库均请求失败，请稍后重试。');
    }

    const widgetTree = renderWidgetFromModel(ctx, model, new Date().toISOString(), true);
    cacheModel(ctx, model, widgetTree);

    if (widget) return widgetTree;

    let report =
      opts.outputFormat === 'json'
        ? JSON.stringify(buildJSON(model, { showFull: opts.showFull }), null, 2)
        : renderReport(model, { showFull: opts.showFull });

    const body = trimForNotification(report);
    model.meta.truncated = body.truncated;

    if (opts.notifyResult) {
      const changeNote = model.ipChange && !model.ipChange.first && model.ipChange.ipChanged
        ? `🔄 IP 已变化 · ${model.ipChange.previous.country || '??'} → ${model.ipChange.current.country || '??'}`
        : model.meta.summarySubtitle;
      ctx.notify({
        title: `${riskEmoji(model.score.level)} IP 质量体检`,
        subtitle: changeNote || undefined,
        body: body.text,
        sound: true,
        action: { type: 'clipboard', text: report },
      });
    }

    return { type: 'text', text: report };
  } catch (error) {
    const message = str((error && error.message) || error);
    return failResult(ctx, widget, '脚本执行失败', message);
  }
}

/** Defensive cache read. */
function safeGetCache(ctx) {
  try {
    const cached = ctx.storage.getJSON(KEYS.last);
    return cached && cached.model ? cached : null;
  } catch {
    return null;
  }
}

/* ===================================================================
 * Widget rendering
 * =================================================================== */

function renderWidgetFromModel(ctx, model, cachedAt, fresh) {
  const family = ctx.widgetFamily || 'systemMedium';
  const score = model.score || { total: null, level: 'unknown' };
  const primary = model.signals.ipApiCom || model.signals.ipApiIs || model.signals.ipInfo || {};
  const color = riskColor(score.level);
  const country = [flagEmoji(primary.country), str(primary.country)].filter(Boolean).join(' ');
  const stale = fresh ? '' : ' (缓存)';
  const ageLabel = cachedAt ? relativeAge(cachedAt) : '';

  // ---- Lock Screen --------------------------------------------------
  if (family === 'accessoryCircular') {
    return {
      type: 'widget',
      children: [
        {
          type: 'stack',
          direction: 'column',
          alignItems: 'center',
          gap: 0,
          children: [
            {
              type: 'text',
              text: score.total === null ? '—' : String(score.total),
              font: { size: 'title3', weight: 'bold' },
              textColor: color,
            },
            { type: 'text', text: 'IP', font: { size: 'caption2' }, textColor: '#FFFFFFAA' },
          ],
        },
      ],
    };
  }

  if (family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [
        {
          type: 'text',
          text: `🌐 ${score.total === null ? '—' : score.total}/100 ${riskLevelCN(score.level)}`,
          font: { size: 'caption1' },
          maxLines: 1,
          minScale: 0.7,
        },
      ],
    };
  }

  if (family === 'accessoryRectangular') {
    return {
      type: 'widget',
      gap: 1,
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 4,
          children: [
            { type: 'image', src: 'sf-symbol:globe', width: 11, height: 11, color },
            {
              type: 'text',
              text: `IP ${score.total === null ? '—' : score.total}/100`,
              font: { size: 'caption1', weight: 'semibold' },
              textColor: color,
            },
            { type: 'spacer' },
            { type: 'text', text: country || `IPv${model.family}`, font: { size: 'caption2' }, textColor: '#FFFFFFAA' },
          ],
        },
        {
          type: 'text',
          text: `${riskLevelCN(score.level)} · ${stale ? '缓存' : ageLabel}`,
          font: { size: 'caption2' },
          textColor: '#FFFFFF99',
          maxLines: 1,
          minScale: 0.7,
        },
      ],
    };
  }

  // ---- Home Screen --------------------------------------------------
  const yes = (model.services || []).filter((s) => s.status === 'yes').length;
  const no = (model.services || []).filter((s) => s.status === 'no').length;
  const flagText = no > 0 ? `${no} 项被屏蔽` : yes > 0 ? `${yes} 项解锁` : '无检测数据';

  if (family === 'systemSmall') {
    return {
      type: 'widget',
      gap: 4,
      padding: 12,
      backgroundGradient: {
        type: 'linear',
        colors: ['#1A1A2E', '#16213E'],
        stops: [0, 1],
        startPoint: { x: 0, y: 0 },
        endPoint: { x: 1, y: 1 },
      },
      refreshAfter: refreshAfter(30),
      children: [
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'center',
          gap: 4,
          children: [
            { type: 'image', src: 'sf-symbol:globe.asia.australia.fill', width: 12, height: 12, color: '#93C5FD' },
            { type: 'text', text: 'IP 质量', font: { size: 'caption2', weight: 'semibold' }, textColor: '#93C5FD' },
            { type: 'spacer' },
            { type: 'text', text: country, font: { size: 'caption2' }, textColor: '#FFFFFFAA', maxLines: 1, minScale: 0.7 },
          ],
        },
        {
          type: 'stack',
          direction: 'row',
          alignItems: 'end',
          gap: 3,
          children: [
            {
              type: 'text',
              text: score.total === null ? '—' : String(score.total),
              font: { size: 32, weight: 'bold' },
              textColor: color,
            },
            { type: 'text', text: '/100', font: { size: 'caption2' }, textColor: '#FFFFFF88' },
          ],
        },
        {
          type: 'text',
          text: `${riskLevelCN(score.level)}${stale}`,
          font: { size: 'caption1', weight: 'semibold' },
          textColor: color,
          maxLines: 1,
          minScale: 0.7,
        },
        { type: 'spacer' },
        { type: 'text', text: flagText, font: { size: 'caption2' }, textColor: '#FFFFFF88', maxLines: 2, minScale: 0.7 },
        { type: 'text', text: ageLabel, font: { size: 'caption2' }, textColor: '#FFFFFF66', maxLines: 1 },
      ],
    };
  }

  const rows = [
    { label: 'ASN', value: primary.asn ? `AS${primary.asn}` : '—' },
    { label: '组织', value: str(primary.isp) || str(primary.org) || '—' },
    { label: '城市', value: str(primary.city) || '—' },
    { label: '类型', value: (model.ipType && model.ipType.label) || '—' },
  ];
  if (family === 'systemLarge' || family === 'systemExtraLarge') {
    rows.push({ label: '解锁', value: yes > 0 ? `${yes} 个服务` : '无数据' });
    rows.push({ label: '屏蔽', value: no > 0 ? `${no} 个服务` : '无' });
  }

  return {
    type: 'widget',
    gap: 5,
    padding: 12,
    backgroundGradient: {
      type: 'linear',
      colors: ['#1A1A2E', '#16213E'],
      stops: [0, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    refreshAfter: refreshAfter(30),
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 5,
        children: [
          { type: 'image', src: 'sf-symbol:globe.asia.australia.fill', width: 13, height: 13, color: '#93C5FD' },
          { type: 'text', text: 'IP 质量体检', font: { size: 'caption1', weight: 'semibold' }, textColor: '#93C5FD' },
          { type: 'spacer' },
          {
            type: 'text',
            text: country || `IPv${model.family}`,
            font: { size: 'caption1', weight: 'medium' },
            textColor: '#FFFFFFAA',
            maxLines: 1,
            minScale: 0.7,
          },
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'end',
        gap: 4,
        children: [
          {
            type: 'text',
            text: score.total === null ? '—' : String(score.total),
            font: { size: 30, weight: 'bold' },
            textColor: color,
          },
          { type: 'text', text: '/100', font: { size: 'caption1' }, textColor: '#FFFFFF88' },
          { type: 'spacer' },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'end',
            gap: 0,
            children: [
              {
                type: 'text',
                text: `${riskLevelCN(score.level)}${stale}`,
                font: { size: 'caption1', weight: 'semibold' },
                textColor: color,
                maxLines: 1,
                minScale: 0.7,
              },
              { type: 'text', text: ageLabel, font: { size: 'caption2' }, textColor: '#FFFFFF77', maxLines: 1 },
            ],
          },
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        gap: 14,
        children: rows.map((row) => ({
          type: 'stack',
          direction: 'column',
          alignItems: 'start',
          gap: 0,
          flex: 1,
          children: [
            { type: 'text', text: row.label, font: { size: 'caption2' }, textColor: '#FFFFFF66', maxLines: 1 },
            {
              type: 'text',
              text: row.value,
              font: { size: 'caption2', weight: 'medium' },
              textColor: '#FFFFFFCC',
              maxLines: 1,
              minScale: 0.6,
            },
          ],
        })),
      },
    ],
  };
}
