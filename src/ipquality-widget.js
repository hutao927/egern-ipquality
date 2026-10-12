/**
 * IP Quality Check for Egern — widget entry
 * ---------------------------------------------------------------
 * Type: generic, referenced by the "IP 质量" widget.
 *
 * Widgets re-render often (roughly every 15-30 minutes plus iOS's own
 * schedule). Running the full multi-database probe on every render
 * would be slow and would burn through the free tiers of the public
 * APIs, so this script:
 *
 *   1. Renders instantly from the cache written by ipquality.js.
 *   2. Only probes when the cache is older than REFRESH_MINUTES.
 *   3. Falls back to the stale cache and labels it, rather than
 *      showing an error card.
 *
 * Run ipquality.js once first to populate the cache.
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

function readWidgetOptions(ctx) {
  return {
    policy: env(ctx, 'POLICY', '') || undefined,
    prefer: env(ctx, 'IP_VERSION', 'auto').toLowerCase(),
    refreshMinutes: envInt(ctx, 'REFRESH_MINUTES', 30, 5, 720),
    autoRefresh: env(ctx, 'AUTO_REFRESH', 'true').toLowerCase() !== 'false',
  };
}

function readCache(ctx) {
  try {
    const cached = ctx.storage.getJSON(KEYS.last);
    return cached && cached.model ? cached : null;
  } catch {
    return null;
  }
}

function isFresh(cached, minutes) {
  if (!cached || !cached.at) return false;
  const age = Date.now() - Date.parse(cached.at);
  return Number.isFinite(age) && age < minutes * 60 * 1000;
}

/** Lightweight re-probe used when the cache is cold or stale. */
async function quickProbe(ctx, opts) {
  const detected = await detectEgressIP(ctx, { policy: opts.policy, prefer: opts.prefer });
  if (!detected) return null;

  const [ipApiIs, ipApiCom] = await Promise.all([
    withTimeout(fetchIpApiIs(ctx, detected.ip, { policy: opts.policy }), 10000),
    withTimeout(fetchIpApiCom(ctx, detected.ip, { policy: opts.policy }), 9000),
  ]);
  if (!ipApiIs && !ipApiCom) return null;

  const signals = {
    ipApiCom,
    ipApiIs,
    ipInfo: null,
    cloudflare: null,
    abuse: null,
    scamalytics: null,
    ipqs: null,
    ipregistry: null,
  };
  const primary = ipApiCom || ipApiIs;
  return {
    ip: detected.ip,
    family: detected.family,
    signals,
    score: computeRiskScore(signals),
    ipType: {
      label: !ipApiIs ? '未知' : ipApiIs.isDatacenter ? '机房 IP' : '住宅/ISP IP',
      native: null,
    },
    usageType: classifyUsageType(signals),
    services: [],
    mail: [],
    cloudflare: null,
    meta: { elapsed: '—', scriptName: 'ipquality-widget', truncated: false },
  };
}

/** Cache a widget-only probe so the next render is instant. */
function writeCache(ctx, model, tree) {
  try {
    const primary = model.signals.ipApiCom || model.signals.ipApiIs || {};
    ctx.storage.setJSON(KEYS.last, {
      summary:
        `${maskIP(model.ip, false)} · ${model.score.total ?? 'N/A'}/100 ` +
        `${riskLevelCN(model.score.level)} · ${str(primary.country) || '??'}`,
      at: new Date().toISOString(),
      model,
      widget: tree,
    });
  } catch {
    // best effort
  }
}

export default async function (ctx) {
  const opts = readWidgetOptions(ctx);
  const cached = readCache(ctx);

  // 1. Fresh cache: render immediately, zero network.
  if (isFresh(cached, opts.refreshMinutes)) {
    return renderTree(ctx, cached.model, cached.at, true);
  }

  // 2. Stale or empty: try a cheap refresh.
  if (opts.autoRefresh) {
    try {
      const model = await quickProbe(ctx, opts);
      if (model) {
        const at = new Date().toISOString();
        const tree = renderTree(ctx, model, at, true);
        writeCache(ctx, model, tree);
        return tree;
      }
    } catch {
      // fall through to the stale cache
    }
  }

  // 3. Stale cache beats an error card.
  if (cached) return renderTree(ctx, cached.model, cached.at, false);

  // 4. Nothing at all.
  return emptyWidget(ctx);
}

/* ===================================================================
 * Widget tree
 * =================================================================== */

function renderTree(ctx, model, cachedAt, fresh) {
  const family = ctx.widgetFamily || 'systemMedium';
  const score = model.score || { total: null, level: 'unknown' };
  const primary = model.signals.ipApiCom || model.signals.ipApiIs || model.signals.ipInfo || {};
  const color = riskColor(score.level);
  const country = [flagEmoji(primary.country), str(primary.country)].filter(Boolean).join(' ');
  const stale = fresh ? '' : ' (缓存)';
  const ageLabel = cachedAt ? relativeAge(cachedAt) : '';

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

  const yes = (model.services || []).filter((s) => s.status === 'yes').length;
  const no = (model.services || []).filter((s) => s.status === 'no').length;
  const flagText = no > 0 ? `${no} 项被屏蔽` : yes > 0 ? `${yes} 项解锁` : '未检测服务';

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

/** Shown when there is neither a cache nor a working network. */
function emptyWidget(ctx) {
  const family = ctx.widgetFamily || 'systemMedium';

  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: 'IP 质量：暂无数据', font: { size: 'caption1' } }] };
  }
  if (family === 'accessoryCircular') {
    return {
      type: 'widget',
      children: [{ type: 'text', text: '—', font: { size: 'title2', weight: 'bold' }, textColor: '#9CA3AF' }],
    };
  }

  return {
    type: 'widget',
    padding: 12,
    gap: 4,
    backgroundColor: '#1A1A2E',
    refreshAfter: refreshAfter(10),
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 5,
        children: [
          { type: 'image', src: 'sf-symbol:globe.asia.australia.fill', width: 12, height: 12, color: '#93C5FD' },
          { type: 'text', text: 'IP 质量体检', font: { size: 'caption1', weight: 'semibold' }, textColor: '#93C5FD' },
        ],
      },
      { type: 'text', text: '暂无数据', font: { size: 'body', weight: 'semibold' }, textColor: '#FFFFFFCC' },
      {
        type: 'text',
        text: '请先在「工具 → 脚本」中手动运行一次 ipquality 以建立缓存。',
        font: { size: 'caption2' },
        textColor: '#FFFFFF88',
        maxLines: 3,
        minScale: 0.7,
      },
    ],
  };
}
