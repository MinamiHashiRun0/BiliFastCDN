// BiliFastCDN —— Surge 后端移植自 Biliverse/Redirect（Apache-2.0，署名见 THIRD-PARTY-NOTICES.md）。
// 本文件只做两件事：把 B 站下发的 CDN 请求换到指定主机，以及渲染状态面板。
// 常规镜像（港澳台 *ov / cn-hk-eq-*、国际版 *bstar1、Akamai）由模块里的静态 [URL Rewrite] 规则
// 直接改写，不经过脚本；只有 MCDN / PCDN 这些带端口或带参数的形式才落到这里。
// 没有测速、没有排名、也不碰 playurl 响应 —— 这些在 Redirect 的后端里本来就不存在。

(function () {
  "use strict";

  var TAG = "[BiliFastCDN] ";
  var VERSION = "1.0.0";
  var K_STATS = "bili_fast_cdn.redirect.v1";

  var DEFAULTS = {
    // Redirect database.mjs 的默认值：三个分类都是阿里云 CDN，MCDN 走代理包裹。
    hostOverseaVideo: "upos-sz-mirrorali.bilivideo.com",
    hostBStar: "upos-sz-mirrorali.bilivideo.com",
    hostPcdn: "upos-sz-mirrorali.bilivideo.com",
    hostMcdn: "proxy-tf-all-ws.bilivideo.com",
    debug: false
  };

  var CFG_ALIASES = {
    host_oversea_video: "hostOverseaVideo",
    host_oversea: "hostOverseaVideo",
    host_bstar: "hostBStar",
    host_pcdn: "hostPcdn",
    host_mcdn: "hostMcdn"
  };

  // 来源主机名分组，逐条照搬 Redirect src/process/Request.mjs 的 switch。
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
    return t.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").toLowerCase();
  }

  function asHost(value, fallback) {
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
    cfg.hostOverseaVideo = asHost(cfg.hostOverseaVideo, DEFAULTS.hostOverseaVideo);
    cfg.hostBStar = asHost(cfg.hostBStar, DEFAULTS.hostBStar);
    cfg.hostPcdn = asHost(cfg.hostPcdn, DEFAULTS.hostPcdn);
    cfg.hostMcdn = asHost(cfg.hostMcdn, DEFAULTS.hostMcdn);
    cfg.debug = asBool(cfg.debug, DEFAULTS.debug);
    return cfg;
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
    if (MAINLAND_MIRRORS.indexOf(host) !== -1) return null;   // 目标本身，不动
    if (OVERSEA_VIDEO_HOSTS.indexOf(host) !== -1) return { host: cfg.hostOverseaVideo, reason: "oversea-video" };
    if (BSTAR_HOSTS.indexOf(host) !== -1) return { host: cfg.hostBStar, reason: "bstar" };
    if (host.indexOf("upos-sz-mirror") === 0 && /ov\.bilivideo\.com$/.test(host)) {
      return { host: cfg.hostOverseaVideo, reason: "oversea-video" };
    }
    if (host.indexOf("cn-hk-eq-") === 0 && /\.bilivideo\.com$/.test(host)) {
      return { host: cfg.hostOverseaVideo, reason: "oversea-video" };
    }
    if (host.indexOf("upos-sz-mirror") === 0 && /bstar1\.bilivideo\.com$/.test(host)) {
      return { host: cfg.hostBStar, reason: "bstar" };
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
      var source = cleanHost(queryParam(query, "xy_usource") || "") || cfg.hostPcdn;
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

  // ---- 计数 / 面板 ----------------------------------------------------------

  function emptyStats() {
    return { calls: 0, rewrites: 0, reasons: {}, last: null };
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

  function recordRequest(hit) {
    var state = loadStats();
    state.calls += 1;
    if (hit) {
      state.rewrites += 1;
      state.reasons[hit.reason] = (state.reasons[hit.reason] || 0) + 1;
      state.last = { reason: hit.reason, from: hit.from, to: hit.to, at: Date.now() };
    }
    writeStore(K_STATS, JSON.stringify(state));
  }

  function shorten(host) {
    return String(host)
      .replace(/\.bilivideo\.(com|cn|net)$/, "")
      .replace(/\.akamaized\.net$/, "")
      .replace(/^upos-/, "");
  }

  function reasonLabel(reason) {
    return REASON_LABELS[reason] || reason;
  }

  function panelTitle() {
    return "B站CDN v" + VERSION;
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

  function runPanel(cfg) {
    try {
      var state = loadStats();
      var lines = [];
      var style = "info";

      lines.push("静态规则（港澳台/国际版）→ " + shorten(cfg.hostOverseaVideo));
      lines.push("脚本 MCDN → " + shorten(cfg.hostMcdn) + " · PCDN → " + shorten(cfg.hostPcdn));
      lines.push("脚本 命中" + state.calls + " 改写" + state.rewrites);
      if (state.last) {
        lines.push("最近 " + reasonLabel(state.last.reason) + "：" +
          shorten(state.last.from) + " → " + shorten(state.last.to));
      }
      if (state.rewrites > 0) style = "good";
      else if (state.calls > 0) lines.push("MCDN/PCDN 里没有需要改写的条目");
      else lines.push("尚未收到 MCDN/PCDN 请求（常规镜像由静态规则处理，不计入这里）");

      done({ title: panelTitle(), content: lines.join("\n"), style: style });
    } catch (e) {
      log("panel: failed (" + (e && e.message) + ")");
      done({ title: panelTitle(), content: "渲染失败：" + (e && e.message), style: "error" });
    }
  }

  // ---- 入口 -----------------------------------------------------------------

  // 角色按上下文判定，不按 $script.type：面板带 $input.purpose，请求脚本带 $request。
  if (typeof $input !== "undefined" && $input && $input.purpose === "panel") {
    runPanel(loadConfig());
  } else if (typeof $request !== "undefined" && $request) {
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
      parseArgument: parseArgument,
      loadConfig: loadConfig,
      parseUrl: parseUrl,
      buildUrl: buildUrl,
      queryParam: queryParam,
      classifyHost: classifyHost,
      rewriteRequest: rewriteRequest,
      loadStats: loadStats
    };
  }
})();
