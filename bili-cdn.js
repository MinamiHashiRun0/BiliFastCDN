// BiliFastCDN · 请求侧改写 —— 后端移植自 Biliverse/Redirect（Apache-2.0，署名见 THIRD-PARTY-NOTICES.md）。
// 判定逐条对照 Redirect 的 src/process/Request.mjs（GET/HEAD 分支）；与上游的区别只有一个：
// 目标主机可以由测速排名决定（参数填 auto），所以改写必须在脚本里做 —— 静态 [URL Rewrite]
// 只能用固定值。排名与面板在 bili-speedtest.js 里，两边共用同一份 $persistentStore 数据。

(function () {
  "use strict";

  var TAG = "[BiliFastCDN] ";
  var VERSION = "1.1.0";
  var K_RANK = "bili_fast_cdn.rank.v2";
  var K_STATS = "bili_fast_cdn.stats.v1";

  var AUTO = "auto";
  var MCDN_PROXY_HOST = "proxy-tf-all-ws.bilivideo.com";
  var BOOTSTRAP_HOST = "upos-sz-mirrorcosov.bilivideo.com";

  var DEFAULTS = {
    // auto = 用测速排名第一；也可以填固定的镜像主机名。
    hostOverseaVideo: AUTO,
    hostBStar: AUTO,
    hostPcdn: AUTO,
    hostMcdn: MCDN_PROXY_HOST,
    debug: false
  };

  var CFG_ALIASES = {
    host_oversea_video: "hostOverseaVideo",
    host_oversea: "hostOverseaVideo",
    host_bstar: "hostBStar",
    host_pcdn: "hostPcdn",
    host_mcdn: "hostMcdn"
  };

  // 来源主机名分组，逐条照搬 Redirect 的 switch。
  var MAINLAND_MIRRORS = [
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorali02.bilivideo.com",
    "upos-sz-mirroralib.bilivideo.com",
    "upos-sz-mirroralio1.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorcosb.bilivideo.com",
    "upos-sz-mirrorcoso1.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorhwb.bilivideo.com",
    "upos-sz-mirrorhwo1.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirror08h.bilivideo.com",
    "upos-sz-mirror08ct.bilivideo.com"
  ];
  var OVERSEA_VIDEO_HOSTS = [
    "upos-hz-mirrorakam.akamaized.net",
    "upos-sz-mirrorakam.akamaized.net",
    "upos-sz-mirrorawsov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirrorhwov.bilivideo.com"
  ];
  var BSTAR_HOSTS = [
    "upos-sz-mirroralibstar1.bilivideo.com",
    "upos-sz-mirrorcosbstar1.bilivideo.com",
    "upos-sz-mirrorhwbstar1.bilivideo.com",
    "upos-bstar1-mirrorakam.akamaized.net"
  ];

  var MCDN_SUFFIX = ".mcdn.bilivideo.cn";
  var REASON_LABELS = {
    "oversea-video": "港澳台",
    "bstar": "国际版",
    "mcdn-port": "MCDN换端口",
    "mcdn-cdn": "MCDN cdn参数",
    "mcdn-sid": "MCDN sid参数",
    "mcdn-proxy": "MCDN代理包裹",
    "pcdn-upsource": "PCDN回原节点",
    "pcdn-path": "PCDN路径内主机"
  };

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

  function cleanHost(host) {
    var t = String(host == null ? "" : host).trim();
    if (!t || t.indexOf("{{{") !== -1) return "";
    if (t.toLowerCase() === AUTO) return AUTO;
    return t.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").toLowerCase();
  }

  function asTarget(value, fallback) {
    return cleanHost(value) || fallback;
  }

  function parseArgument(text) {
    var out = {};
    if (typeof text !== "string" || !text) return out;
    var parts = text.split("&");
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq === -1) continue;
      var key = parts[i].slice(0, eq).trim();
      var value = parts[i].slice(eq + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  }

  function loadConfig() {
    var merged = parseArgument(typeof $argument === "string" ? $argument : "");
    var cfg = {};
    var key;
    for (key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) cfg[key] = DEFAULTS[key];
    }
    for (key in merged) {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) continue;
      var target = Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? key : (CFG_ALIASES[key] || null);
      if (target) cfg[target] = merged[key];
    }
    cfg.hostOverseaVideo = asTarget(cfg.hostOverseaVideo, DEFAULTS.hostOverseaVideo);
    cfg.hostBStar = asTarget(cfg.hostBStar, DEFAULTS.hostBStar);
    cfg.hostPcdn = asTarget(cfg.hostPcdn, DEFAULTS.hostPcdn);
    cfg.hostMcdn = asTarget(cfg.hostMcdn, DEFAULTS.hostMcdn);
    cfg.debug = asBool(cfg.debug, DEFAULTS.debug);
    return cfg;
  }

  // ---- 测速排名（与 bili-speedtest.js 共用同一个 key 与格式） ------------------

  function loadRank() {
    var j = safeParse(readStore(K_RANK));
    if (!j || !j.ranking || !j.ranking.length) return null;
    var hosts = [];
    for (var i = 0; i < j.ranking.length; i++) {
      var h = cleanHost(j.ranking[i]);
      if (h && h !== AUTO && hosts.indexOf(h) === -1) hosts.push(h);
    }
    return hosts.length ? { at: j.at || 0, ranking: hosts } : null;
  }

  // 分类目标：填了固定主机就用它；auto 用测速第一；还没测速就落到兜底主机。
  function resolveTarget(cfg, key) {
    var value = cfg[key];
    if (value && value !== AUTO) return value;
    var rank = loadRank();
    return rank ? rank.ranking[0] : BOOTSTRAP_HOST;
  }

  // ---- URL ------------------------------------------------------------------

  function parseUrl(raw) {
    if (typeof raw !== "string" || !raw) return null;
    var m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(raw);
    if (!m) return null;
    var authority = m[2];
    var host = authority;
    var port = "";
    var colon = authority.lastIndexOf(":");
    if (colon !== -1 && authority.indexOf("]") < colon) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
    return {
      scheme: m[1].toLowerCase(),
      host: host.toLowerCase(),
      port: port,
      path: m[3] || "/",
      query: m[4] || "",
      raw: raw
    };
  }

  function buildUrl(scheme, host, port, path, query) {
    return scheme + "://" + host + (port ? ":" + port : "") + (path || "/") + (query || "");
  }

  function queryParam(query, name) {
    if (!query) return null;
    var body = query.charAt(0) === "?" ? query.slice(1) : query;
    var parts = body.split("&");
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      var key = eq === -1 ? parts[i] : parts[i].slice(0, eq);
      if (decodeURIComponent(key) !== name) continue;
      return eq === -1 ? "" : decodeURIComponent(parts[i].slice(eq + 1));
    }
    return null;
  }

  function mcdnPortFor(path, scheme) {
    if (path.indexOf("/v1/resource/") === 0) return scheme === "http" ? "8000" : "8082";
    if (path.indexOf("/upgcxcode/") === 0) return scheme === "http" ? "9102" : "4483";
    return "";
  }

  // ---- 判定（逐条对照 Redirect 的 GET/HEAD 分支） ---------------------------

  function classifyHost(cfg, host) {
    if (OVERSEA_VIDEO_HOSTS.indexOf(host) !== -1) {
      return { host: resolveTarget(cfg, "hostOverseaVideo"), reason: "oversea-video" };
    }
    if (BSTAR_HOSTS.indexOf(host) !== -1) {
      return { host: resolveTarget(cfg, "hostBStar"), reason: "bstar" };
    }
    if (host.indexOf("upos-sz-mirror") === 0 && /ov\.bilivideo\.com$/.test(host)) {
      return { host: resolveTarget(cfg, "hostOverseaVideo"), reason: "oversea-video" };
    }
    if (host.indexOf("cn-hk-eq-") === 0 && /\.bilivideo\.com$/.test(host)) {
      return { host: resolveTarget(cfg, "hostOverseaVideo"), reason: "oversea-video" };
    }
    if (host.indexOf("upos-sz-mirror") === 0 && /bstar1\.bilivideo\.com$/.test(host)) {
      return { host: resolveTarget(cfg, "hostBStar"), reason: "bstar" };
    }
    // 其余镜像（大陆与融合 CDN）：上游把它们当"目标本身"放过。用户要 auto 选最快时，
    // 它们也收敛到测速第一；固定目标时保持上游语义。
    if (/^upos-[a-z0-9-]+\.bilivideo\.(com|cn|net)$/.test(host)) {
      if (cfg.hostPcdn !== AUTO) return null;
      var fast = resolveTarget(cfg, "hostPcdn");
      return fast && fast !== host ? { host: fast, reason: "pcdn-host" } : null;
    }
    return undefined;                                         // 交给端口判断
  }

  function moved(url, from, to, reason) {
    return { url: url, from: from, to: to, reason: reason };
  }

  // 返回 { url, from, to, reason }；无需改动时返回 null。
  function rewriteRequest(raw, cfg) {
    var url = parseUrl(raw);
    if (!url) return null;
    var host = url.host;
    var port = url.port;
    var scheme = url.scheme;
    var path = url.path;
    var query = url.query;

    var byHost = classifyHost(cfg, host);
    if (byHost) {
      if (host === byHost.host && !port) return null;
      return moved(buildUrl(scheme, byHost.host, "", path, query), host, byHost.host, byHost.reason);
    }

    if (port === "") {
      if (host.slice(-MCDN_SUFFIX.length) !== MCDN_SUFFIX) return null;
      var nextPort = mcdnPortFor(path, scheme);
      if (!nextPort) return null;
      return moved(buildUrl(scheme, host, nextPort, path, query), host, host + ":" + nextPort, "mcdn-port");
    }

    if (port === "486") {
      // MCDN
      var cdn = queryParam(query, "cdn");
      var sid = queryParam(query, "sid");
      if (cdn) return moved(buildUrl(scheme, "d1--" + cdn + ".bilivideo.com", "", path, query), host, "d1--" + cdn + ".bilivideo.com", "mcdn-cdn");
      if (sid) return moved(buildUrl(scheme, sid + ".bilivideo.com", "", path, query), host, sid + ".bilivideo.com", "mcdn-sid");
      return null;
    }

    if (port === "4480") {
      // PCDN：回到 xy_usource 指向的原节点，没有就落到分类目标。
      var source = cleanHost(queryParam(query, "xy_usource") || "") || resolveTarget(cfg, "hostPcdn");
      return moved(buildUrl("http", source, "", path, query), host, source, "pcdn-upsource");
    }

    if (port === "8000" || port === "8082") return null;      // MCDN.v1.resource，保持原样

    if (port === "4483" || port === "9102") {
      // MCDN.upgcxcode → 代理包裹；已经是 .bilivideo.com、或带 originalUrl 的跳过，避免回环。
      if (/\.bilivideo\.com$/.test(host)) return null;
      if (queryParam(query, "originalUrl") !== null) return null;
      return moved(buildUrl("http", cfg.hostMcdn, "", "/", "?url=" + encodeURIComponent(raw)),
        host + ":" + port, cfg.hostMcdn, "mcdn-proxy");
    }

    if (port === "9305") {
      // PCDN：主机名藏在路径第一段里。
      var segs = path.split("/").filter(function (s) { return s !== ""; });
      var head = segs.shift();
      if (!head) return null;
      return moved(buildUrl("http", head, "", "/" + segs.join("/"), query), host, head, "pcdn-path");
    }

    return null;
  }

  // ---- 计数 -----------------------------------------------------------------

  function loadStats() {
    var j = safeParse(readStore(K_STATS));
    var out = { calls: 0, rewrites: 0, reasons: {}, last: null };
    if (!j || typeof j !== "object") return out;
    var keys = Object.keys(out);
    for (var i = 0; i < keys.length; i++) {
      if (j[keys[i]] !== undefined && j[keys[i]] !== null) out[keys[i]] = j[keys[i]];
    }
    return out;
  }

  function recordRequest(hit) {
    var state = loadStats();
    state.calls += 1;
    if (hit) {
      state.rewrites += 1;
      state.reasons[hit.reason] = (state.reasons[hit.reason] || 0) + 1;
      state.last = { reason: REASON_LABELS[hit.reason] || hit.reason, from: hit.from, to: hit.to, at: Date.now() };
    }
    writeStore(K_STATS, JSON.stringify(state));
  }

  function runRequest(cfg) {
    try {
      var url = ($request && $request.url) || "";
      var hit = rewriteRequest(url, cfg);
      recordRequest(hit);
      if (!hit) return done();
      if (cfg.debug) log("request: " + hit.reason + " " + hit.from + " -> " + hit.to);
      done({ url: hit.url });
    } catch (e) {
      log("request: failed, passing through (" + (e && e.message) + ")");
      done();
    }
  }

  if (typeof $request !== "undefined" && $request) {
    runRequest(loadConfig());
  } else {
    done();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      VERSION: VERSION,
      DEFAULTS: DEFAULTS,
      CFG_ALIASES: CFG_ALIASES,
      MAINLAND_MIRRORS: MAINLAND_MIRRORS,
      OVERSEA_VIDEO_HOSTS: OVERSEA_VIDEO_HOSTS,
      BSTAR_HOSTS: BSTAR_HOSTS,
      K_RANK: K_RANK,
      K_STATS: K_STATS,
      parseArgument: parseArgument,
      loadConfig: loadConfig,
      loadRank: loadRank,
      resolveTarget: resolveTarget,
      parseUrl: parseUrl,
      buildUrl: buildUrl,
      queryParam: queryParam,
      classifyHost: classifyHost,
      rewriteRequest: rewriteRequest
    };
  }
})();
