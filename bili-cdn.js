// BiliFastCDN — Surge 模块脚本，一个文件三种角色（改写 / 测速 / 面板），按运行上下文分派。
// 判定逻辑移植自 bilibili-accelerator.user.js（MIT, realzza），署名见 THIRD-PARTY-NOTICES.md。
(function () {
  "use strict";

  var TAG = "[BiliFastCDN] ";
  var SCRIPT_TYPE = (typeof $script !== "undefined" && $script && $script.type) || "";

  var K_RANK = "bili_fast_cdn.rank.v1";
  var K_SAMPLE = "bili_fast_cdn.sample.v1";
  var K_STATS = "bili_fast_cdn.stats.v1";

  // Surge 对远程脚本默认缓存 86400 秒，面板标题带版本号才能确认设备上跑的是哪一版。
  var VERSION = "0.3.1";
  var PANEL_TITLE = "B站CDN";
  var REASON_LABELS = {
    "force-host": "全量改写",
    "pcdn-host": "PCDN替换",
    "mcdn-host": "MCDN替换",
    "mcdn-proxy": "MCDN代理",
    "scheduler": "调度器回源",
    "akamai-host": "Akamai替换",
    "grpc-host": "gRPC替换"
  };
  // 一次 playurl 响应会改写多个 URL，调试通知必须限流，不能按响应逐条发。
  var DEBUG_NOTIFY_MS = 30000;
  var MAX_LOGGED_DETAILS = 6;

  // 候选池：海外镜像优先。Akamai 不列入 —— 它对 upos 签名路径返回 403，永远赢不了测速。
  var CANDIDATE_POOL = [
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "upos-sz-mirrorhwov.bilivideo.com",
    "upos-sz-mirrorali.bilivideo.com",
    "upos-tf-all-hw.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-tf-all-tx.bilivideo.com"
  ];

  var DEFAULT_HOST = "upos-sz-mirrorcosov.bilivideo.com";
  var MCDN_PROXY_HOST = "proxy-tf-all-ws.bilivideo.com";

  var DEFAULTS = {
    enabled: true,
    mode: "smart",              // smart | force | bad-only | off
    // MCDN 默认走代理包裹：realzza 与 Biliverse/Redirect 两个独立项目都这么默认，
    // 目标都是 proxy-tf-all-ws。想换回直接换 host 就改成 replace。
    mcdnStrategy: "proxy",      // replace | proxy | off
    // 分类目标覆盖（对齐 Redirect 的 Host.* 分类）。auto = 用测速排名第一。
    hostPcdn: "auto",
    hostOversea: "auto",
    hostBStar: "auto",
    hostMcdn: MCDN_PROXY_HOST,
    liveFilter: true,
    backupFanout: true,
    rewriteAkamai: false,
    portHeuristic: true,
    notify: true,
    debug: false,
    // 明文 HTTP 的分片请求改写（无需 MitM）。
    mediaRewrite: true,
    // gRPC（protobuf）响应改写：App 的 playurl 走这里。
    grpcRewrite: true,
    // App 的 playurl 响应实测全是 gzip 帧，不解压就一次也改不动。默认关：改写后只能
    // 按"未压缩帧"发回去（`$utils` 只有 ungzip，没有 gzip），万一某个客户端只认压缩帧，
    // 整条 playurl 会失败 —— 这个风险交给用户显式打开。
    grpcGunzip: false,
    rankTtlMs: 6 * 60 * 60 * 1000,
    sampleTtlMs: 90 * 60 * 1000,
    // 注意单位：Surge $httpClient 的 timeout 是秒，本文件其余 TTL 是毫秒。
    probeTimeout: 4,
    probeBytes: 1024 * 1024
  };

  var CFG_ALIASES = {
    backup_fanout: "backupFanout",
    media_rewrite: "mediaRewrite",
    grpc_rewrite: "grpcRewrite",
    grpc_gunzip: "grpcGunzip",
    host_pcdn: "hostPcdn",
    host_oversea: "hostOversea",
    host_bstar: "hostBStar",
    host_mcdn: "hostMcdn",
    live_filter: "liveFilter",
    mcdn_strategy: "mcdnStrategy",
    port_heuristic: "portHeuristic",
    rewrite_akamai: "rewriteAkamai",
    rank_ttl_ms: "rankTtlMs",
    sample_ttl_ms: "sampleTtlMs",
    probe_timeout: "probeTimeout",
    probe_bytes: "probeBytes"
  };

  var MAX_DEPTH = 20;
  var MAX_BACKUPS = 8;

  var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  var MEDIA_RE = /\.(m4s|mp4|flv|m3u8)(?:$|[?#])/i;
  var IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  var XY_MCDN_RE = /^xy(?:\d+x){3}\d+xy\.mcdn\.bilivideo\.(?:cn|com|net)$/i;

  var P2P_SUFFIXES = [".szbdyd.com", ".mountaintoys.cn", ".nexusedgeio.com", ".ahdohpiechei.com"];
  var P2P_HOSTS = ["upos-sz-mirror14b.bilivideo.com"];

  var finished = false;

  function log(msg) {
    try { console.log(TAG + msg); } catch (e) {}
  }

  function done(payload) {
    if (finished) return;
    finished = true;
    try { if (typeof $done === "function") $done(payload || {}); } catch (e) {}
  }

  function readStore(key) {
    try { return $persistentStore.read(key); } catch (e) { return null; }
  }

  function writeStore(key, value) {
    try { return $persistentStore.write(value, key); } catch (e) { return false; }
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function asBool(value, fallback) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      var s = value.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "off" || s === "no") return false;
    }
    return fallback;
  }

  function asHost(value, fallback) {
    var v = typeof value === "string" ? value.trim() : "";
    if (!v || v.indexOf("{{{") !== -1) return fallback;
    return cleanHost(v) || fallback;
  }

  function asNumber(value, fallback) {
    var n = parseFloat(value);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function parseArgument(raw) {
    var out = {};
    if (raw == null) return out;
    if (typeof raw === "object") return raw;
    var s = String(raw).trim();
    if (!s) return out;
    if (s.charAt(0) === "{") {
      var obj = safeParse(s);
      if (obj && typeof obj === "object") return obj;
    }
    var pairs = s.split("&");
    for (var i = 0; i < pairs.length; i++) {
      if (!pairs[i]) continue;
      var eq = pairs[i].indexOf("=");
      var key = eq === -1 ? pairs[i] : pairs[i].slice(0, eq);
      var val = eq === -1 ? "true" : pairs[i].slice(eq + 1);
      try { key = decodeURIComponent(key); val = decodeURIComponent(val); } catch (e) {}
      if (val.indexOf("{{{") !== -1 || val.indexOf("}}}") !== -1) continue;
      out[key] = val;
    }
    return out;
  }

  function loadConfig() {
    var cfg = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) cfg[k] = DEFAULTS[k];
    }
    var merged = parseArgument(typeof $argument === "undefined" ? "" : $argument);
    for (var mk in merged) {
      if (!Object.prototype.hasOwnProperty.call(merged, mk)) continue;
      var key = CFG_ALIASES[mk] || mk;
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) cfg[key] = merged[mk];
    }
    if (["smart", "force", "bad-only", "off"].indexOf(cfg.mode) === -1) cfg.mode = DEFAULTS.mode;
    if (["replace", "proxy", "off"].indexOf(cfg.mcdnStrategy) === -1) cfg.mcdnStrategy = DEFAULTS.mcdnStrategy;
    cfg.enabled = asBool(cfg.enabled, DEFAULTS.enabled);
    cfg.notify = asBool(cfg.notify, DEFAULTS.notify);
    cfg.debug = asBool(cfg.debug, DEFAULTS.debug);
    cfg.liveFilter = asBool(cfg.liveFilter, DEFAULTS.liveFilter);
    cfg.backupFanout = asBool(cfg.backupFanout, DEFAULTS.backupFanout);
    cfg.mediaRewrite = asBool(cfg.mediaRewrite, DEFAULTS.mediaRewrite);
    cfg.grpcRewrite = asBool(cfg.grpcRewrite, DEFAULTS.grpcRewrite);
    cfg.grpcGunzip = asBool(cfg.grpcGunzip, DEFAULTS.grpcGunzip);
    cfg.hostPcdn = asHost(cfg.hostPcdn, DEFAULTS.hostPcdn);
    cfg.hostOversea = asHost(cfg.hostOversea, DEFAULTS.hostOversea);
    cfg.hostBStar = asHost(cfg.hostBStar, DEFAULTS.hostBStar);
    cfg.hostMcdn = asHost(cfg.hostMcdn, DEFAULTS.hostMcdn);
    cfg.rewriteAkamai = asBool(cfg.rewriteAkamai, DEFAULTS.rewriteAkamai);
    cfg.portHeuristic = asBool(cfg.portHeuristic, DEFAULTS.portHeuristic);
    cfg.rankTtlMs = asNumber(cfg.rankTtlMs, DEFAULTS.rankTtlMs);
    cfg.sampleTtlMs = asNumber(cfg.sampleTtlMs, DEFAULTS.sampleTtlMs);
    cfg.probeTimeout = asNumber(cfg.probeTimeout, DEFAULTS.probeTimeout);
    cfg.probeBytes = asNumber(cfg.probeBytes, DEFAULTS.probeBytes);
    return cfg;
  }

  function cleanHost(host) {
    var t = String(host == null ? "" : host).trim();
    t = t.replace(/^https?:\/\//i, "");
    var i = t.search(/[/?#]/);
    if (i !== -1) t = t.slice(0, i);
    return t.toLowerCase();
  }

  function parseUrl(value) {
    if (typeof value !== "string" || value.length < 8) return null;
    var s = value;
    if (s.slice(0, 2) === "//") s = "https:" + s;
    if (!/^https?:\/\//i.test(s)) return null;

    var rest = s.slice(s.indexOf("://") + 3);
    var cut = rest.length;
    for (var i = 0; i < rest.length; i++) {
      var c = rest.charAt(i);
      if (c === "/" || c === "?" || c === "#") { cut = i; break; }
    }
    var authority = rest.slice(0, cut);
    var tail = rest.slice(cut);
    var at = authority.lastIndexOf("@");
    if (at !== -1) authority = authority.slice(at + 1);

    var host = authority;
    var port = "";
    var colon = authority.lastIndexOf(":");
    if (colon !== -1) { host = authority.slice(0, colon); port = authority.slice(colon + 1); }
    if (!host) return null;

    var q = tail.indexOf("?");
    return {
      // 分片请求是明文 http，改写时必须保持原 scheme，别把 http 悄悄变成 https。
      scheme: /^http:/i.test(s) ? "http" : "https",
      host: host.toLowerCase(),
      port: port,
      path: q === -1 ? tail : tail.slice(0, q),
      query: q === -1 ? "" : tail.slice(q),
      tail: tail
    };
  }

  // 只换 host：path 与 query 逐字节保留，签名在 query 里，改动即失效。
  function swapHost(rawUrl, host, scheme) {
    if (typeof rawUrl !== "string") return null;
    var idx = rawUrl.indexOf("://");
    var start = idx === -1 ? 2 : idx + 3;
    var cut = rawUrl.length;
    for (var i = start; i < rawUrl.length; i++) {
      var c = rawUrl.charAt(i);
      if (c === "/" || c === "?" || c === "#") { cut = i; break; }
    }
    return (scheme || "https") + "://" + cleanHost(host) + rawUrl.slice(cut);
  }

  function isMediaPath(p) {
    return MEDIA_RE.test(p.path + p.query) ||
      p.path.indexOf("/upgcxcode/") === 0 ||
      p.path.indexOf("/v1/resource/") === 0;
  }

  // 直播是另一套 CDN 层级，换域名会直接打死播放，只能剔除 PCDN 条目。
  function isLivePath(p) {
    return p.path.indexOf("/live-bvc/") !== -1;
  }

  function hasNonDefaultPort(p) {
    return p.port !== "" && p.port !== "80" && p.port !== "443";
  }

  function hasMcdnQuery(p) {
    return /(?:^|[?&])os=mcdn(?:&|$)/i.test(p.query);
  }

  function isMcdnHost(h) {
    return /\.mcdn\.bilivideo\.(?:cn|com|net)$/i.test(h);
  }

  function isBiliCdnHost(h) {
    return /\.bilivideo\.(?:com|cn|net)$/i.test(h) || /\.akamaized\.net$/i.test(h);
  }

  function isKnownP2pHost(h) {
    if (P2P_HOSTS.indexOf(h) !== -1) return true;
    for (var i = 0; i < P2P_SUFFIXES.length; i++) {
      var suffix = P2P_SUFFIXES[i];
      if (h.length > suffix.length && h.slice(h.length - suffix.length) === suffix) return true;
    }
    return h.indexOf("upos-") === 0 && h.split(".")[0].indexOf("302") !== -1;
  }

  function hasMediaSignal(value) {
    if (typeof value !== "string") return false;
    return value.indexOf("bilivideo") !== -1 ||
      value.indexOf("akamaized.net") !== -1 ||
      value.indexOf("szbdyd.com") !== -1 ||
      value.indexOf("mountaintoys") !== -1 ||
      value.indexOf("nexusedgeio") !== -1 ||
      value.indexOf("ahdohpiechei") !== -1 ||
      value.indexOf("mcdn.bili") !== -1 ||
      value.indexOf("acgvideo") !== -1 ||
      value.indexOf("os=mcdn") !== -1 ||
      value.indexOf("/upgcxcode/") !== -1 ||
      value.indexOf("/v1/resource/") !== -1;
  }

  function classify(p, cfg) {
    var h = p.host;
    var schedulerSource = null;
    if (/\.szbdyd\.com$/i.test(h)) {
      var m = /(?:^|[?&])xy_usource=([^&]+)/i.exec(p.query);
      if (m) {
        var decoded = m[1];
        try { decoded = decodeURIComponent(decoded); } catch (e) {}
        schedulerSource = cleanHost(decoded) || null;
      }
    }
    return {
      host: h,
      scheduler: /\.szbdyd\.com$/i.test(h),
      schedulerSource: schedulerSource,
      mcdn: isMcdnHost(h),
      akamai: /\.akamaized\.net$/i.test(h),
      // 裸 IP 不算劣质节点。上游是把 ipLike 当 PCDN 的，但它在浏览器里跑，播放器有
      // backup_url 和卡顿恢复；这里一旦判成劣质就会把播放器正在用的那条 URL 换掉。
      // 实测（2026-09-18 HAR）：App 的 playurl 会下发裸 IP 形式的 CDN 地址
      // （203.121.59.225 = upos-hz-mirrorakam 的 Akamai 边缘，92.223.116.254 = cosov 的
      // G-Core 边缘，os= 参数分别就是 akam / cosovbv），那是 App 自己做 HTTPDNS 的结果，
      // 不是 P2P；按"劣质"改写反而把能用的地址换成了打不开的主机名。
      pcdn: XY_MCDN_RE.test(h) || isKnownP2pHost(h) ||
        (cfg.portHeuristic && hasNonDefaultPort(p)) || hasMcdnQuery(p)
    };
  }

  function isSlowLiveHost(hostValue, extra, cfg) {
    var raw = String(hostValue == null ? "" : hostValue);
    var p = parseUrl(raw.indexOf("://") !== -1 ? raw : "https://" + raw.replace(/^\/\//, ""));
    if (!p) return false;
    var h = p.host;
    if (IP_RE.test(h) || XY_MCDN_RE.test(h) || isMcdnHost(h) || isKnownP2pHost(h)) return true;
    if (cfg.portHeuristic && hasNonDefaultPort(p)) return true;
    return typeof extra === "string" && /(?:^|[?&])os=mcdn(?:&|$)/i.test(extra);
  }

  function loadRank(cfg) {
    var raw = readStore(K_RANK);
    if (!raw) return null;
    var j = safeParse(raw);
    if (!j || !j.ranking || !j.ranking.length) return null;
    var hosts = [];
    for (var i = 0; i < j.ranking.length; i++) {
      var h = cleanHost(j.ranking[i]);
      if (h && hosts.indexOf(h) === -1) hosts.push(h);
    }
    if (!hosts.length) return null;
    return {
      at: j.at || 0,
      via: j.via || "",
      fresh: (Date.now() - (j.at || 0)) < cfg.rankTtlMs,
      ranking: hosts,
      samples: j.samples || [],
      rejected: j.rejected || []
    };
  }

  function bestHost(cfg, rank) {
    return rank && rank.ranking.length ? rank.ranking[0] : DEFAULT_HOST;
  }

  function poolForFanout(cfg, rank) {
    return rank && rank.ranking.length ? rank.ranking : CANDIDATE_POOL;
  }

  function throughputMbps(bytes, ms) {
    if (!(bytes > 0) || !(ms > 0)) return 0;
    return (bytes * 8) / ms / 1000;
  }

  function rankSamples(results) {
    var ok = [];
    for (var i = 0; i < results.length; i++) {
      if (results[i] && results[i].ok) ok.push(results[i]);
    }
    ok.sort(function (a, b) {
      if (b.mbps !== a.mbps) return b.mbps - a.mbps;
      return a.ms - b.ms;
    });
    return ok;
  }

  function proxyUrl(rawUrl, host, scheme) {
    return (scheme || "https") + "://" + cleanHost(host) + "/?url=" + encodeURIComponent(rawUrl);
  }

  // 分类按来源主机名判定，条件对齐 Biliverse/Redirect：*ov 与 cn-hk-eq-* 属港澳台、
  // *bstar1 属国际版，其余按大陆处理。
  function categoryOf(host) {
    var h = cleanHost(host);
    if (h.indexOf("upos-sz-mirror") === 0 && /ov\.bilivideo\.com$/.test(h)) return "oversea";
    if (h.indexOf("cn-hk-eq-") === 0 && /\.bilivideo\.com$/.test(h)) return "oversea";
    if (/bstar1\.bilivideo\.com$/.test(h)) return "bstar";
    return "pcdn";
  }

  // 用户手填的分类固定目标，auto 表示没填（那就用测速排名）。
  function pinnedFor(cfg, host) {
    var category = categoryOf(host);
    var override = category === "oversea" ? cfg.hostOversea
      : (category === "bstar" ? cfg.hostBStar : cfg.hostPcdn);
    return override && override !== "auto" ? override : null;
  }

  // 某个来源主机该换到哪：分类固定目标优先，否则用测速排名第一。
  function targetFor(cfg, rank, host) {
    // MCDN 走代理包裹时，字节层只能换主机名（拿不到整条 URL），所以这里落到
    // hostMcdn —— 与 Redirect 把 mcdn 主机名换成 proxy-tf-all-ws 的做法一致。
    if (isMcdnHost(host) && cfg.mcdnStrategy === "proxy") return cleanHost(cfg.hostMcdn);
    return pinnedFor(cfg, host) || bestHost(cfg, rank);
  }

  // smart: 响应层全量改写，分片层只动劣质节点。
  // force: 两层都全量改写。bad-only: 只动 PCDN / MCDN 等劣质节点。
  //
  // 分片层（scope=media）为什么在 smart 下不全量改写：http-request 拿到的是播放器
  // 已经在用的那条 URL，换掉之后播放器手上没有第二条地址可退。实测把一条分片的主备
  // 候选（akam / cosov）都收敛到同一个主机名之后，该主机名在本地解析到一个没有该域名
  // 的 CDN 边缘（403 X-Tengine-Error: non-existent domain），主备一起失败，整集放不出来。
  // 响应层能全量改写是因为那里还能补 backupUrl 扇出，分片层补不了。
  function rewriteOne(rawUrl, cfg, rank, scope) {
    if (!hasMediaSignal(rawUrl)) return null;
    var p = parseUrl(rawUrl);
    if (!p || !isMediaPath(p) || isLivePath(p)) return null;
    if (p.host === cleanHost(cfg.hostMcdn)) return null;

    var v = classify(p, cfg);
    var target = targetFor(cfg, rank, p.host);
    var forceAll = cfg.mode === "force" ||
      (cfg.mode === "smart" && scope !== "media" && !!(rank && rank.ranking.length));

    // 已经是目标节点就直接放过：http-request 改写后 Surge 会拿新 URL 重跑脚本，
    // 这一行断开回环。
    if (p.host === target) return null;

    if (v.scheduler) {
      return v.schedulerSource
        ? moved(swapHost(rawUrl, v.schedulerSource, p.scheme), p.host, v.schedulerSource, "scheduler")
        : null;
    }
    if (v.mcdn && cfg.mcdnStrategy !== "off") {
      if (cfg.mcdnStrategy === "proxy") {
        return moved(proxyUrl(rawUrl, cfg.hostMcdn, p.scheme), p.host, cfg.hostMcdn, "mcdn-proxy");
      }
      return moved(swapHost(rawUrl, target, p.scheme), p.host, target, "mcdn-host");
    }
    if (v.pcdn) return moved(swapHost(rawUrl, target, p.scheme), p.host, target, "pcdn-host");
    if (cfg.rewriteAkamai && v.akamai) {
      return moved(swapHost(rawUrl, target, p.scheme), p.host, target, "akamai-host");
    }

    // 分类固定目标是用户手填的，分片层同样照办 —— 那是显式意图，不是测速猜的。
    if ((forceAll || pinnedFor(cfg, p.host)) && isBiliCdnHost(p.host) && p.host !== target) {
      return moved(swapHost(rawUrl, target, p.scheme), p.host, target, "force-host");
    }
    return null;
  }

  function moved(url, from, to, reason) {
    return { url: url, from: from, to: to, reason: reason };
  }

  function rewriteValue(node, cfg, rank, stats, depth, seen) {
    if (node == null || depth > MAX_DEPTH) return node;

    if (typeof node === "string") {
      var hit = rewriteOne(node, cfg, rank);
      if (!hit) return node;
      stats.count += 1;
      stats.reasons[hit.reason] = (stats.reasons[hit.reason] || 0) + 1;
      if (stats.details && stats.details.length < MAX_LOGGED_DETAILS) {
        stats.details.push({ reason: hit.reason, from: hit.from, to: hit.to });
      }
      return hit.url;
    }
    if (typeof node !== "object") return node;
    if (seen.has(node)) return node;
    seen.add(node);

    var i;
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) {
        node[i] = rewriteValue(node[i], cfg, rank, stats, depth + 1, seen);
      }
      return node;
    }
    var keys = Object.keys(node);
    for (i = 0; i < keys.length; i++) {
      node[keys[i]] = rewriteValue(node[keys[i]], cfg, rank, stats, depth + 1, seen);
    }
    return node;
  }

  function mergeBackups(entry, key, base, pool) {
    if (typeof base !== "string") return 0;
    var parsed = parseUrl(base);
    if (!parsed) return 0;
    var current = parsed.host;

    var merged = [];
    for (var i = 0; i < pool.length; i++) {
      var h = cleanHost(pool[i]);
      if (!h || h === current) continue;
      var alt = swapHost(base, h);
      if (merged.indexOf(alt) === -1) merged.push(alt);
    }
    if (!merged.length) return 0;

    var existing = Array.isArray(entry[key]) ? entry[key] : [];
    for (i = 0; i < existing.length; i++) {
      if (merged.indexOf(existing[i]) === -1) merged.push(existing[i]);
    }
    merged = merged.slice(0, MAX_BACKUPS);

    if (merged.length === existing.length) {
      var same = true;
      for (i = 0; i < merged.length; i++) {
        if (merged[i] !== existing[i]) { same = false; break; }
      }
      if (same) return 0;
    }
    entry[key] = merged;
    return 1;
  }

  function enrichDash(dash, pool) {
    if (!dash || typeof dash !== "object") return 0;
    var kinds = ["video", "audio"];
    var changed = 0;
    for (var i = 0; i < kinds.length; i++) {
      var list = dash[kinds[i]];
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        var entry = list[j];
        if (!entry) continue;
        if (typeof entry.baseUrl === "string") changed += mergeBackups(entry, "backupUrl", entry.baseUrl, pool);
        if (typeof entry.base_url === "string") changed += mergeBackups(entry, "backup_url", entry.base_url, pool);
      }
    }
    return changed;
  }

  function enrichDurl(durl, pool) {
    if (!Array.isArray(durl)) return 0;
    var changed = 0;
    for (var i = 0; i < durl.length; i++) {
      var entry = durl[i];
      if (entry && typeof entry.url === "string") changed += mergeBackups(entry, "backup_url", entry.url, pool);
    }
    return changed;
  }

  function enrichBackups(root, pool) {
    if (!root || typeof root !== "object") return 0;
    var containers = [root.data, root.result, root.result && root.result.video_info, root];
    var changed = 0;
    for (var i = 0; i < containers.length; i++) {
      var c = containers[i];
      if (!c || typeof c !== "object") continue;
      changed += enrichDash(c.dash, pool);
      changed += enrichDurl(c.durl, pool);
    }
    return changed;
  }

  function filterLiveUrlInfo(node, cfg, depth, seen) {
    if (!node || typeof node !== "object" || depth > MAX_DEPTH || seen.has(node)) return 0;
    seen.add(node);

    var changed = 0;
    var list = node.url_info;
    if (Array.isArray(list) && list.length > 1) {
      var allHosts = true;
      for (var i = 0; i < list.length; i++) {
        if (!list[i] || typeof list[i].host !== "string") { allHosts = false; break; }
      }
      if (allHosts) {
        var kept = [];
        for (i = 0; i < list.length; i++) {
          if (!isSlowLiveHost(list[i].host, list[i].extra, cfg)) kept.push(list[i]);
        }
        if (kept.length > 0 && kept.length < list.length) {
          list.length = 0;
          for (i = 0; i < kept.length; i++) list.push(kept[i]);
          changed += 1;
        }
      }
    }

    // 数组按下标遍历：用元素当 key 会查 node["[object Object]"]，递归在这里静默断掉。
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) {
        changed += filterLiveUrlInfo(node[i], cfg, depth + 1, seen);
      }
      return changed;
    }
    var keys = Object.keys(node);
    for (i = 0; i < keys.length; i++) {
      changed += filterLiveUrlInfo(node[keys[i]], cfg, depth + 1, seen);
    }
    return changed;
  }

  // 取第一个签名分片 URL 当测速样本，优先视频（体积大，速率更真实）。
  function findSample(root) {
    var best = null;
    (function walk(node, depth) {
      if (best || node == null || depth > MAX_DEPTH) return;
      if (typeof node === "string") {
        if (!hasMediaSignal(node)) return;
        var p = parseUrl(node);
        if (!p || !isMediaPath(p) || isLivePath(p) || p.host === MCDN_PROXY_HOST) return;
        if (/\.(m4s|mp4|flv)(?:$|[?#])/i.test(p.path + p.query)) best = node;
        return;
      }
      if (typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (var j = 0; j < node.length && !best; j++) walk(node[j], depth + 1);
        return;
      }
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length && !best; i++) walk(node[keys[i]], depth + 1);
    })(root, 0);
    return best;
  }

  function saveSample(url) {
    if (!url) return;
    writeStore(K_SAMPLE, JSON.stringify({ at: Date.now(), url: url }));
  }

  function loadSample(cfg) {
    var raw = readStore(K_SAMPLE);
    if (!raw) return null;
    var j = safeParse(raw);
    if (!j || !j.url || typeof j.url !== "string") return null;
    if ((Date.now() - (j.at || 0)) > cfg.sampleTtlMs) return null;
    return j.url;
  }

  function emptyStats() {
    return {
      calls: 0, signals: 0, rewrites: 0, liveDropped: 0,
      grpcCalls: 0, grpcRewrites: 0, grpcLast: null,
      mediaCalls: 0, mediaRewrites: 0, last: null, lastNotifyAt: 0
    };
  }

  function humanBytes(n) {
    if (!(n > 0)) return "0";
    if (n < 1024) return n + "B";
    if (n < 1048576) return Math.round(n / 1024) + "KB";
    return (Math.round(n / 104857.6) / 10) + "MB";
  }

  function loadStats() {
    var j = safeParse(readStore(K_STATS));
    var out = emptyStats();
    if (!j || typeof j !== "object") return out;
    var keys = Object.keys(out);
    for (var i = 0; i < keys.length; i++) {
      if (j[keys[i]] !== undefined && j[keys[i]] !== null) out[keys[i]] = j[keys[i]];
    }
    return out;
  }

  // 每次调用都计数，且在读到响应体之前就计：calls / signals / rewrites 三个数字
  // 分别对应「脚本没被触发」「触发了但响应体里没有媒体地址」「读到了但无需改写」，
  // 只有第一个才是 MitM 没生效。
  function recordResponse(cfg, stats, isLive, rank) {
    var state = loadStats();
    if (stats.binary) {
      // gRPC 层单独计数：它和 JSON 层的失败模式完全不同（引擎能力 / 二进制 body）。
      // 同时把最近一次的帧结构信息存进面板，这样不用翻日志就能看出为什么改写是 0。
      state.grpcCalls += 1;
      state.grpcRewrites += stats.grpcRewrites;
      if (stats.grpcInfo) {
        state.grpcLast = {
          at: Date.now(),
          bytes: stats.grpcInfo.bytes,
          frames: stats.grpcInfo.frames,
          compressed: stats.grpcInfo.compressed,
          framed: stats.grpcInfo.framed,
          rewrites: stats.grpcRewrites
        };
      }
    } else {
      state.calls += 1;
      if (stats.signal) state.signals += 1;
      state.rewrites += stats.count;
      if (isLive) state.liveDropped += stats.count;
    }
    if (stats.details.length) {
      var last = stats.details[stats.details.length - 1];
      state.last = { reason: last.reason, from: last.from, to: last.to, at: Date.now() };
    }
    if (cfg.debug && stats.count && (Date.now() - (state.lastNotifyAt || 0)) > DEBUG_NOTIFY_MS) {
      state.lastNotifyAt = Date.now();
      notifyRewrite(stats, bestHost(cfg, rank));
    }
    writeStore(K_STATS, JSON.stringify(state));
  }

  // 媒体层每条分片都会调用一次，所以只做一次 read+write，也不参与通知限流。
  function recordRequest(cfg, hit) {
    var state = loadStats();
    state.mediaCalls += 1;
    if (hit) {
      state.mediaRewrites += 1;
      state.last = { reason: hit.reason, from: hit.from, to: hit.to, at: Date.now() };
    }
    writeStore(K_STATS, JSON.stringify(state));
  }

  function probeHost(host, sampleUrl, cfg, cb) {
    var target = sampleUrl ? swapHost(sampleUrl, host) : "https://" + cleanHost(host) + "/";
    var headers = { "User-Agent": UA, "Accept": "*/*" };
    if (sampleUrl) {
      headers["Range"] = "bytes=0-" + (cfg.probeBytes - 1);
      headers["Referer"] = "https://www.bilibili.com/";
    }
    var started = Date.now();

    $httpClient.get({ url: target, headers: headers, timeout: cfg.probeTimeout }, function (err, resp, data) {
      var ms = Date.now() - started;
      var status = resp && (resp.status || resp.statusCode) ? (resp.status || resp.statusCode) : 0;

      if (!sampleUrl) {
        if (err || !status) return cb({ host: host, ok: false, ms: ms, mbps: 0, status: status });
        return cb({ host: host, ok: true, ms: ms, mbps: 0, status: status, latOnly: true });
      }

      if (err || status < 200 || status >= 300 || !data) {
        return cb({ host: host, ok: false, ms: ms, mbps: 0, status: status });
      }
      if (data.charAt(0) === "<") {
        return cb({ host: host, ok: false, ms: ms, mbps: 0, status: status });
      }
      cb({ host: host, ok: true, ms: ms, mbps: throughputMbps(data.length, ms), status: status });
    });
  }

  function probeAll(hosts, sampleUrl, cfg, cb) {
    var results = new Array(hosts.length);
    var pending = hosts.length;
    if (!pending) return cb([]);
    for (var i = 0; i < hosts.length; i++) {
      (function (index) {
        probeHost(hosts[index], sampleUrl, cfg, function (result) {
          results[index] = result;
          pending -= 1;
          if (pending === 0) cb(results);
        });
      })(i);
    }
  }

  function bootstrapSample(cb) {
    var headers = {
      "User-Agent": UA,
      "Referer": "https://www.bilibili.com/",
      "Accept": "application/json, text/plain, */*"
    };
    var listUrl = "https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1";

    $httpClient.get({ url: listUrl, headers: headers, timeout: 6 }, function (err, resp, data) {
      var bvid = null;
      var cid = null;
      var j = safeParse(data);
      var list = (j && j.data && j.data.list) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].bvid && list[i].cid) {
          bvid = list[i].bvid;
          cid = list[i].cid;
          break;
        }
      }
      if (!bvid || !cid) {
        log("bootstrap: no popular video (" + (err || "status " + (resp && (resp.status || resp.statusCode))) + ")");
        return cb(null);
      }

      var playUrl = "https://api.bilibili.com/x/player/playurl?bvid=" + bvid +
        "&cid=" + cid + "&qn=64&fnval=16&fnver=0&fourk=1";
      $httpClient.get({ url: playUrl, headers: headers, timeout: 8 }, function (e2, r2, d2) {
        var sample = findSample(safeParse(d2));
        if (sample) {
          log("bootstrap: got a signed sample from " + bvid);
          return cb(sample);
        }
        log("bootstrap: playurl carried no media url (" + (e2 || "status " + (r2 && (r2.status || r2.statusCode))) + ")");
        cb(null);
      });
    });
  }

  function saveRank(ranked, via, results) {
    var payload = {
      at: Date.now(),
      via: via,
      ranking: [],
      samples: [],
      rejected: []
    };
    for (var i = 0; i < ranked.length; i++) {
      payload.ranking.push(ranked[i].host);
      payload.samples.push({
        host: ranked[i].host,
        mbps: Math.round(ranked[i].mbps * 100) / 100,
        ms: ranked[i].ms
      });
    }
    // 被剔除的候选要留痕：测速时 403 的节点不可能是好的目标，但用户得看得见
    // "我选的这个节点当时就被否了"，而不是只看到一个空排名。
    var all = results || [];
    for (i = 0; i < all.length; i++) {
      if (all[i] && !all[i].ok) {
        payload.rejected.push({ host: all[i].host, status: all[i].status || 0 });
      }
    }
    writeStore(K_RANK, JSON.stringify(payload));
  }

  function shorten(host) {
    return String(host)
      .replace(/\.bilivideo\.(com|cn|net)$/, "")
      .replace(/\.akamaized\.net$/, "")
      .replace(/^upos-/, "");
  }

  // 测速时被否掉的候选，最多列两个，剩下的折成 +N。
  function rejectedTail(rejected) {
    if (!rejected || !rejected.length) return "";
    var parts = [];
    for (var i = 0; i < rejected.length && i < 2; i++) {
      parts.push(shorten(rejected[i].host) + (rejected[i].status ? "(" + rejected[i].status + ")" : ""));
    }
    if (rejected.length > 2) parts.push("+" + (rejected.length - 2));
    return " · 剔除 " + parts.join(" ");
  }

  function reasonLabel(reason) {
    return REASON_LABELS[reason] || reason;
  }

  function notifyBest(ranked, via, cfg) {
    var limit = cfg.debug ? ranked.length : 3;
    var lines = [];
    for (var i = 0; i < ranked.length && i < limit; i++) {
      lines.push(shorten(ranked[i].host) + " " + ranked[i].mbps.toFixed(1) + " Mbps / " + ranked[i].ms + "ms");
    }
    if (via !== "sample") lines.push("仅延迟测速：播放一次视频后会自动做吞吐测速");
    try {
      $notification.post("BiliFastCDN 测速完成", "最快 " + shorten(ranked[0].host), lines.join("\n"));
    } catch (e) {}
  }

  function notifyRewrite(stats, target) {
    var lines = [];
    for (var i = 0; i < stats.details.length && i < 4; i++) {
      var d = stats.details[i];
      lines.push(shorten(d.from) + " → " + shorten(d.to) + "（" + reasonLabel(d.reason) + "）");
    }
    try {
      $notification.post("BiliFastCDN 改写成功",
        stats.count + " 处 → " + shorten(target),
        lines.length ? lines.join("\n") : "直播 PCDN 剔除 " + stats.count + " 处");
    } catch (e) {}
  }

  function logSamples(results) {
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      log("probe: " + r.host + " status=" + r.status + " " + r.ms + "ms " +
        (r.ok ? (r.mbps ? r.mbps.toFixed(2) + "Mbps" : "latency-only") : "rejected"));
    }
  }

  function probeRound(cfg, cb) {
    var sample = loadSample(cfg);

    function finish(results, via) {
      var ranked = rankSamples(results);

      if (!ranked.length && via === "sample") {
        log("probe: no host accepted the sample, retrying latency-only");
        writeStore(K_SAMPLE, "");
        return probeAll(CANDIDATE_POOL, null, cfg, function (latencyResults) {
          finish(latencyResults, "rtt");
        });
      }

      if (!ranked.length) return cb(null, via);

      saveRank(ranked, via, results);
      log("probe: via=" + via + " best=" + ranked[0].host + " " +
        ranked[0].mbps.toFixed(2) + "Mbps " + ranked[0].ms + "ms");
      cb(ranked, via);
    }

    function go(url) {
      log("probe: testing " + CANDIDATE_POOL.length + " hosts via " + (url ? "a signed sample" : "latency only"));
      probeAll(CANDIDATE_POOL, url, cfg, function (results) {
        if (cfg.debug) logSamples(results);
        finish(results, url ? "sample" : "rtt");
      });
    }

    if (sample) return go(sample);
    bootstrapSample(function (bootstrapped) {
      if (bootstrapped) saveSample(bootstrapped);
      go(bootstrapped);
    });
  }

  function runCron(cfg) {
    if (!cfg.enabled || cfg.mode === "off") {
      log("cron: disabled");
      return done();
    }

    var cached = loadRank(cfg);
    if (cached && cached.fresh) {
      log("cron: ranking still fresh (" + Math.round((Date.now() - cached.at) / 60000) + "min), skip");
      return done();
    }

    probeRound(cfg, function (ranked, via) {
      if (!ranked) {
        log("cron: nobody answered, keeping " + (cached ? "the previous ranking" : "the default host"));
        return done();
      }
      if (cfg.notify) notifyBest(ranked, via, cfg);
      done();
    });
  }

  function runPanel(cfg) {
    try {
      if (!cfg.enabled || cfg.mode === "off") {
        return done({ title: panelTitle(), content: "已停用（模块参数 enabled=false）", style: "alert" });
      }
      if (typeof $trigger !== "undefined" && $trigger === "button") {
        log("panel: refresh tapped, starting a probe round");
        return probeRound(cfg, function (ranked) {
          panelReport(cfg, ranked ? null : "本次测速没有任何节点应答");
        });
      }
      panelReport(cfg, null);
    } catch (e) {
      log("panel: failed (" + (e && e.message) + ")");
      done({ title: panelTitle(), content: "渲染失败：" + (e && e.message), style: "error" });
    }
  }

  function panelTitle() {
    return PANEL_TITLE + " v" + VERSION;
  }

  function panelReport(cfg, note) {
    var rank = loadRank(cfg);
    var state = loadStats();
    var lines = [];
    var style = "info";

    if (rank && rank.ranking.length) {
      var best = rank.samples && rank.samples.length ? rank.samples[0] : null;
      var rate = best && best.mbps ? best.mbps.toFixed(1) + " Mbps" : (best ? "延迟 " + best.ms + "ms" : "");
      var ageMin = Math.round((Date.now() - rank.at) / 60000);
      lines.push("目标 " + shorten(rank.ranking[0]) + (rate ? " · " + rate : ""));
      lines.push("测速 " + (ageMin < 1 ? "刚刚" : ageMin + " 分钟前") + " · " + rank.ranking.length + " 个节点" +
        rejectedTail(rank.rejected));
    } else {
      lines.push(shorten(DEFAULT_HOST) + "（兜底，尚未测速）");
      lines.push(note ? note : "点刷新按钮立即测速");
    }

    lines.push("接口 触发" + state.calls + " 媒体" + state.signals + " 改写" + state.rewrites);
    // gRPC 那行的尾巴直接给出最近一次的帧结构：改写为 0 时，这里就能看出是
    // 压缩帧、不是帧结构，还是真的没有可换的主机名 —— 不必去翻日志。
    var gTail = "";
    if (state.grpcLast) {
      var gl = state.grpcLast;
      gTail = " · 最近 " + humanBytes(gl.bytes) + " 帧" + gl.frames + " 改写" + gl.rewrites +
        (gl.unzipped ? " 解压" + gl.unzipped : "") +
        (gl.compressed ? " 压缩" + gl.compressed : "") + (gl.framed ? "" : " 非帧");
    }
    lines.push("gRPC 扫描" + state.grpcCalls + " 改写" + state.grpcRewrites + gTail);
    lines.push("分片 扫描" + state.mediaCalls + " 改写" + state.mediaRewrites +
      (state.liveDropped ? " 直播剔除" + state.liveDropped : ""));
    // 分片层在 smart 下只修劣质节点，改写 0 是常态。写在卡片上，省得又去猜是不是没生效。
    if (cfg.mode === "smart" && state.mediaCalls > state.mediaRewrites) {
      lines.push("分片 smart 只修劣质节点（force 才全量）");
    }
    if (state.last) {
      lines.push("最近 " + reasonLabel(state.last.reason) + "：" +
        shorten(state.last.from) + " → " + shorten(state.last.to));
    }

    // 接口层要 MitM 才看得到（网页版 playurl）；分片层看的是明文 http，不需要 MitM，
    // App 只有后者覆盖得到。两个计数器分开，才能分辨是配置问题还是客户端不走这条路。
    if (state.rewrites > 0 || state.grpcRewrites > 0 || state.mediaRewrites > 0) style = "good";
    else if (state.calls === 0 && state.grpcCalls === 0 && state.mediaCalls === 0) {
      lines.push("未收到任何流量：检查模块版本与 MitM");
    }
    else if (state.calls > 0 && state.signals === 0) lines.push("接口已触发但响应里没有媒体地址");
    else lines.push("有流量但无需改写");

    done({ title: panelTitle(), content: lines.join("\n"), style: style });
  }

  // 明文 HTTP 的分片请求走这一支：不需要 MitM，所以官方 App 也覆盖得到（它的
  // playurl 是 gRPC/protobuf，payload 改写碰不到，但它的分片是 http）。
  // scope=media 让 smart 模式在这里退化成"只修劣质节点"，理由见 rewriteOne。
  function runRequest(cfg) {
    try {
      var url = ($request && $request.url) || "";
      if (!cfg.enabled || cfg.mode === "off" || !cfg.mediaRewrite) return done();

      var p = parseUrl(url);
      if (!p || !isMediaPath(p) || isLivePath(p)) return done();

      var hit = rewriteOne(url, cfg, loadRank(cfg), "media");
      recordRequest(cfg, hit);
      if (!hit) return done();

      if (cfg.debug) log("request: " + hit.reason + " " + hit.from + " -> " + hit.to);
      done({ url: hit.url });
    } catch (e) {
      log("request: failed, passing through (" + (e && e.message) + ")");
      done();
    }
  }

  // ---- gRPC / protobuf -----------------------------------------------------
  // PlayViewUnite / PlayConf 这类 gRPC 响应的 body 是 protobuf，媒体 URL 是
  // length-delimited 字符串字段。这里不做 schema 解析，而是在字节层：
  //   递归走一遍 message 结构 → 认出主机名 → 替换 → 同步修正长度前缀
  // 没有发生替换时输出与输入逐字节相同（由测试守着），所以识别失误不会损坏响应；
  // 另外替换后还会再校验一次能否解析，失败就整段放弃。
  // B 站在持续把 HTTP 接口迁到 gRPC，所以判定按内容做，不按方法名写死。

  var PROTO_ANCHORS = [
    ".bilivideo.com", ".bilivideo.cn", ".bilivideo.net", ".akamaized.net",
    ".szbdyd.com", ".mountaintoys.cn", ".nexusedgeio.com", ".ahdohpiechei.com"
  ];
  var PROTO_MAX_DEPTH = 12;

  function isHostByte(c) {
    return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46;
  }

  function readVarint(buf, pos, end) {
    var value = 0;
    var shift = 0;
    while (pos < end) {
      var b = buf[pos];
      pos += 1;
      value += (b & 127) * Math.pow(2, shift);
      if ((b & 128) === 0) return { value: value, next: pos };
      shift += 7;
      if (shift > 63) return null;
    }
    return null;
  }

  function varintBytes(value) {
    var out = [];
    var v = value;
    do {
      var b = v % 128;
      v = Math.floor(v / 128);
      out.push(v > 0 ? b + 128 : b);
    } while (v > 0);
    return out;
  }

  // 找出 [start,end) 里所有形如 <sub>.<anchor> 的主机名区间，按出现位置升序。
  function hostSpans(buf, start, end) {
    var spans = [];
    for (var a = 0; a < PROTO_ANCHORS.length; a++) {
      var anchor = PROTO_ANCHORS[a];
      var alen = anchor.length;
      var i = start;
      while (i + alen <= end) {
        var match = true;
        for (var k = 0; k < alen; k++) {
          if (buf[i + k] !== anchor.charCodeAt(k)) { match = false; break; }
        }
        if (!match) { i += 1; continue; }
        var hs = i;
        while (hs > start && isHostByte(buf[hs - 1])) hs -= 1;
        spans.push({ start: hs, end: i + alen });
        i = i + alen;
      }
    }
    spans.sort(function (x, y) { return x.start - y.start; });
    var out = [];
    for (i = 0; i < spans.length; i++) {
      if (!out.length || spans[i].start >= out[out.length - 1].end) out.push(spans[i]);
    }
    return out;
  }

  function spanHost(buf, span) {
    var s = "";
    for (var i = span.start; i < span.end; i++) s += String.fromCharCode(buf[i]);
    return s.toLowerCase();
  }

  // 字节层（gRPC）只清劣质节点，不碰健康节点。
  // 原因：JSON 层改写后能补 backupUrl 扇出，protobuf 里补不了 —— 把健康节点也收敛到
  // 同一个 host 等于拆掉播放器自己的多 CDN 容错，那个 host 一抖整段就卡。
  function shouldMoveHost(host, cfg, rank) {
    if (host === targetFor(cfg, rank, host)) return false;
    if (isMcdnHost(host) && cfg.mcdnStrategy !== "off") return true;
    // 裸 IP 不换：那是 App 用 HTTPDNS 拿到的 CDN 边缘地址，不是 P2P 节点，判据同 classify。
    if (isKnownP2pHost(host) || XY_MCDN_RE.test(host)) return true;
    if (/\.akamaized\.net$/i.test(host)) return cfg.rewriteAkamai;
    // 用户明确指定了该分类的目标（不是 auto）时，健康节点也照换 —— 那是显式意图。
    if (pinnedFor(cfg, host)) return true;
    return false;
  }

  // 返回替换后的字节（Uint8Array），无需替换时返回 null。
  function swapHostsInBytes(buf, start, end, cfg, rank, stats) {
    var spans = hostSpans(buf, start, end);
    if (!spans.length) return null;
    var swaps = [];
    for (var i = 0; i < spans.length; i++) {
      var host = spanHost(buf, spans[i]);
      if (!shouldMoveHost(host, cfg, rank)) continue;
      swaps.push({
        start: spans[i].start,
        end: spans[i].end,
        host: host,
        to: targetFor(cfg, rank, host)
      });
    }
    if (!swaps.length) return null;

    var out = [];
    var cursor = start;
    for (i = 0; i < swaps.length; i++) {
      var sw = swaps[i];
      for (var j = cursor; j < sw.start; j++) out.push(buf[j]);
      for (j = 0; j < sw.to.length; j++) out.push(sw.to.charCodeAt(j));
      cursor = sw.end;
      if (stats) {
        stats.grpcRewrites += 1;
        stats.details.push({ reason: "grpc-host", from: sw.host, to: sw.to });
      }
    }
    for (j = cursor; j < end; j++) out.push(buf[j]);
    return new Uint8Array(out);
  }

  // 递归重建：valid 表示这段字节确实是一个合法 message；out 非空表示内部发生了替换。
  function walkMessage(buf, start, end, cfg, rank, stats, depth) {
    var invalid = { valid: false, out: null };
    if (depth > PROTO_MAX_DEPTH) return invalid;
    var pos = start;
    // 每个字段先记成一段：未改动的是原始区间，改动的是重编码后的字节。
    // 全部记完再按需展开 —— 否则某字段一旦被替换，它之前的字段就丢了。
    var segs = [];
    var changed = false;

    while (pos < end) {
      var segStart = pos;
      var tag = readVarint(buf, pos, end);
      if (!tag || tag.value === 0) return invalid;
      pos = tag.next;
      var tagEnd = pos;
      var wire = tag.value & 7;

      if (wire === 0) {
        var v = readVarint(buf, pos, end);
        if (!v) return invalid;
        pos = v.next;
        segs.push({ a: segStart, b: pos });
      } else if (wire === 1) {
        if (pos + 8 > end) return invalid;
        pos += 8;
        segs.push({ a: segStart, b: pos });
      } else if (wire === 5) {
        if (pos + 4 > end) return invalid;
        pos += 4;
        segs.push({ a: segStart, b: pos });
      } else if (wire === 2) {
        var len = readVarint(buf, pos, end);
        if (!len) return invalid;
        var lenEnd = len.next;
        var payStart = lenEnd;
        var payEnd = payStart + len.value;
        if (payEnd > end) return invalid;

        var sub = walkMessage(buf, payStart, payEnd, cfg, rank, stats, depth + 1);
        var replaced = sub.valid
          ? sub.out                                              // 是 message：以递归结果为准
          : swapHostsInBytes(buf, payStart, payEnd, cfg, rank, stats);   // 不是：当字符串处理
        if (replaced) {
          // tag 原样，长度前缀按新 payload 重写，payload 用替换结果
          var blk = [];
          for (var q = segStart; q < tagEnd; q++) blk.push(buf[q]);
          var newLen = varintBytes(replaced.length);
          for (q = 0; q < newLen.length; q++) blk.push(newLen[q]);
          for (q = 0; q < replaced.length; q++) blk.push(replaced[q]);
          segs.push({ bytes: blk });
          changed = true;
        } else {
          segs.push({ a: segStart, b: payEnd });
        }
        pos = payEnd;
      } else {
        return invalid;
      }
    }

    if (pos !== end) return invalid;
    if (!changed) return { valid: true, out: null };

    var flat = [];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].bytes) {
        for (var j = 0; j < segs[i].bytes.length; j++) flat.push(segs[i].bytes[j]);
      } else {
        for (var k = segs[i].a; k < segs[i].b; k++) flat.push(buf[k]);
      }
    }
    return { valid: true, out: new Uint8Array(flat) };
  }

  function rewriteProto(buf, cfg, rank, stats) {
    var result = walkMessage(buf, 0, buf.length, cfg, rank, stats, 0);
    if (!result.out) return null;
    // 替换后必须仍能解析，否则整段放弃（宁可不动，也不要写出坏 body）
    var verify = walkMessage(result.out, 0, result.out.length, cfg, null, null, 0);
    if (!verify.valid) return null;
    return result.out;
  }

  // gRPC 的 body 不是裸 protobuf，而是帧序列：每帧 1 字节压缩标志 + 4 字节大端长度 + 消息。
  // 直接当裸 message 解析的话，第一字节（标志位，通常 0）就被判为非法 tag，一次都改不成。
  function int32Bytes(value) {
    return [
      Math.floor(value / 16777216) % 256,
      Math.floor(value / 65536) % 256,
      Math.floor(value / 256) % 256,
      value % 256
    ];
  }

  // 返回 { out, frames, compressed, framed }；out 为 null 表示无需改动或结构不可信。
  function rewriteGrpcBody(buf, cfg, rank, stats) {
    var pos = 0;
    var segs = [];
    var changed = false;
    var frames = 0;
    var compressed = 0;
    var unzipped = 0;

    while (pos + 5 <= buf.length) {
      var flag = buf[pos];
      var len = buf[pos + 1] * 16777216 + buf[pos + 2] * 65536 + buf[pos + 3] * 256 + buf[pos + 4];
      var payEnd = pos + 5 + len;
      if (payEnd > buf.length) break;          // 帧不完整：不做任何改动
      frames += 1;

      if (flag !== 0) {
        compressed += 1;
        var plain = cfg.grpcGunzip ? gunzipPayload(buf, pos + 5, payEnd) : null;
        var subC = plain ? walkMessage(plain, 0, plain.length, cfg, rank, stats, 0) : null;
        if (subC && subC.out) {
          // 解压后改写了，就没法再压回去（Surge 只有 ungzip）—— 按"未压缩帧"发回去。
          // gRPC 的压缩标志是逐帧的（flag=0 表示这帧没压缩），客户端必须两种都收。
          var nlC = int32Bytes(subC.out.length);
          segs.push(0);
          for (var c = 0; c < 4; c++) segs.push(nlC[c]);
          for (c = 0; c < subC.out.length; c++) segs.push(subC.out[c]);
          changed = true;
          unzipped += 1;
        } else {
          for (var f = pos; f < payEnd; f++) segs.push(buf[f]);
        }
      } else {
        var sub = walkMessage(buf, pos + 5, payEnd, cfg, rank, stats, 0);
        if (sub.out) {
          var nl = int32Bytes(sub.out.length);
          segs.push(flag);
          for (var q = 0; q < 4; q++) segs.push(nl[q]);
          for (q = 0; q < sub.out.length; q++) segs.push(sub.out[q]);
          changed = true;
        } else {
          for (q = pos; q < payEnd; q++) segs.push(buf[q]);
        }
      }
      pos = payEnd;
    }

    if (pos !== buf.length) return { out: null, frames: frames, compressed: compressed, unzipped: 0, framed: false };
    if (!changed) return { out: null, frames: frames, compressed: compressed, unzipped: 0, framed: true };
    return { out: new Uint8Array(segs), frames: frames, compressed: compressed, unzipped: unzipped, framed: true };
  }

  // 官方 App 的 playurl 响应实测 100% 是压缩帧（5/5：2990B gzip → 12476B message），
  // 所以字节层在默认配置下其实一次也改不动 —— 这条路径得先解开 gzip。
  function gunzipPayload(buf, start, end) {
    if (typeof $utils === "undefined" || !$utils || typeof $utils.ungzip !== "function") return null;
    if (end - start < 2 || buf[start] !== 0x1f || buf[start + 1] !== 0x8b) return null;
    var copy = new Uint8Array(end - start);
    for (var i = start; i < end; i++) copy[i - start] = buf[i] & 255;
    try {
      var out = $utils.ungzip(copy);
      return out && out.length ? out : null;
    } catch (e) { return null; }
  }

  function responseHeaders() {
    var out = {};
    var src = ($response && $response.headers) || {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    }
    var drop = ["Content-Length", "content-length", "Content-Encoding", "content-encoding"];
    for (var i = 0; i < drop.length; i++) delete out[drop[i]];
    return out;
  }

  function runResponse(cfg) {
    try {
      var body = $response && $response.body;
      var reqUrl = ($request && $request.url) || "";
      var isLive = /getRoomPlayInfo/i.test(reqUrl);
      var stats = { count: 0, reasons: {}, details: [], signal: false };
      var parsed = null;
      var rank = null;
      var out = null;

      if (!cfg.enabled || cfg.mode === "off") return done();

      // gRPC：模块那行开了 binary-body-mode，body 是 Uint8Array 而不是字符串。
      if (body && typeof body !== "string" && typeof body.length === "number") {
        var bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
        var gstats = { count: 0, reasons: {}, details: [], signal: true, binary: true, grpcRewrites: 0 };
        var gRank = loadRank(cfg);

        var gres = { out: null, frames: 0, compressed: 0, unzipped: 0, framed: false };
        if (cfg.grpcRewrite) {
          gres = rewriteGrpcBody(bytes, cfg, gRank, gstats);
          out = gres.out;
        }
        if (gstats.grpcRewrites) gstats.count = gstats.grpcRewrites;
        gstats.grpcInfo = {
          bytes: bytes.length,
          frames: gres.frames,
          compressed: gres.compressed,
          unzipped: gres.unzipped,
          framed: gres.framed
        };
        recordResponse(cfg, gstats, false, gRank);

        if (cfg.debug) {
          log("grpc: bytes=" + bytes.length +
            " frames=" + gres.frames + (gres.compressed ? " compressed=" + gres.compressed : "") +
            (gres.unzipped ? " unzipped=" + gres.unzipped : "") +
            (gres.framed ? "" : " not-framed") +
            " rewrites=" + gstats.grpcRewrites);
          for (var gi = 0; gi < gstats.details.length && gi < MAX_LOGGED_DETAILS; gi++) {
            log("  " + gstats.details[gi].from + " -> " + gstats.details[gi].to);
          }
        }

        if (out !== null) done({ body: out, headers: responseHeaders() });
        else done();
        return;
      }

      stats.signal = typeof body === "string" && hasMediaSignal(body);
      if (stats.signal) parsed = safeParse(body);

      if (parsed) {
        rank = loadRank(cfg);
        var pool = poolForFanout(cfg, rank);

        if (isLive) {
          if (cfg.liveFilter) {
            var dropped = filterLiveUrlInfo(parsed, cfg, 0, new Set());
            stats.count += dropped;
            if (dropped) stats.reasons["live-filter"] = dropped;
          }
        } else {
          var sample = findSample(parsed);
          rewriteValue(parsed, cfg, rank, stats, 0, new Set());
          if (cfg.backupFanout) stats.count += enrichBackups(parsed, pool);
          if (sample) saveSample(sample);
        }

        if (stats.count) out = JSON.stringify(parsed);
      }

      recordResponse(cfg, stats, isLive, rank);

      if (cfg.debug) {
        // 主机名与路径不放进来：那条请求本身就是上下文，而 Surge 会把过长的日志行
        // 掐掉尾巴（实测 "compresse<...14...>"），关键数字必须落在前面才看得见。
        var line = "response: bytes=" + (typeof body === "string" ? body.length : "-") +
          " signal=" + stats.signal;
        if (parsed) {
          line += " code=" + (parsed.code === undefined ? "-" : parsed.code) +
            " rewrites=" + stats.count + " " + JSON.stringify(stats.reasons) +
            " target=" + bestHost(cfg, rank);
        }
        log(line);
        for (var di = 0; di < stats.details.length; di++) {
          log("  " + stats.details[di].reason + " " + stats.details[di].from +
            " -> " + stats.details[di].to);
        }
      }

      if (out !== null) done({ body: out, headers: responseHeaders() });
      else done();
    } catch (e) {
      log("response: failed, passing through (" + (e && e.message) + ")");
      done();
    }
  }

  // 角色按上下文判定，不按 $script.type：面板带 $input.purpose，响应脚本带 $response，
  // 请求脚本带 $request，剩下的就是测速。精确匹配类型字符串会把一次改名变成静默失效。
  if (typeof $input !== "undefined" && $input && $input.purpose === "panel") {
    runPanel(loadConfig());
  } else if (typeof $response !== "undefined" && $response) {
    runResponse(loadConfig());
  } else if (SCRIPT_TYPE === "http-request") {
    runRequest(loadConfig());
  } else {
    try {
      runCron(loadConfig());
    } catch (e) {
      log("probe: failed (" + (e && e.message) + ")");
      done();
    }
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      VERSION: VERSION,
      DEFAULTS: DEFAULTS,
      CANDIDATE_POOL: CANDIDATE_POOL,
      cleanHost: cleanHost,
      parseUrl: parseUrl,
      swapHost: swapHost,
      isMediaPath: isMediaPath,
      classify: classify,
      isSlowLiveHost: isSlowLiveHost,
      rewriteOne: rewriteOne,
      rewriteValue: rewriteValue,
      enrichBackups: enrichBackups,
      filterLiveUrlInfo: filterLiveUrlInfo,
      findSample: findSample,
      rewriteProto: rewriteProto,
      rewriteGrpcBody: rewriteGrpcBody,
      shouldMoveHost: shouldMoveHost,
      categoryOf: categoryOf,
      targetFor: targetFor,
      rankSamples: rankSamples,
      throughputMbps: throughputMbps,
      loadConfig: loadConfig,
      parseArgument: parseArgument,
      hasMediaSignal: hasMediaSignal
    };
  }
})();
