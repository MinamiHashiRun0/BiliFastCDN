// BiliFastCDN · 响应侧改写（playurl）—— 按 Biliverse/Redirect 的 response 分支思路实现
// （它那版 beta 产物所在的 beta 分支已不存在，这里是本项目按同样的语义自写：拿到 playurl 响应后
// 把里面的媒体地址换到目标主机，播放器随后整段都用新地址）。
// 与请求侧 bili-cdn.js 共用同一套分类、同一份测速排名（bili_fast_cdn.rank.v2）与计数
// （bili_fast_cdn.stats.v1）。面板在 bili-speedtest.js 里。
// 安全性质：没有发生替换时输出与输入逐字节相同；改写后的 protobuf 会再校验一次能否解析，
// 失败就整段放弃；gzip 帧用 $utils.ungzip 解开后按"未压缩帧"发回（Surge 没有 gzip，压不回去）。

(function () {
  "use strict";

  var TAG = "[BiliFastCDN] ";
  var VERSION = "1.1.2";
  var K_RANK = "bili_fast_cdn.rank.v2";
  var K_STATS = "bili_fast_cdn.stats.v1";
  var K_SAMPLE = "bili_fast_cdn.sample.v1";

  var AUTO = "auto";
  var MCDN_PROXY_HOST = "proxy-tf-all-ws.bilivideo.com";
  var BOOTSTRAP_HOST = "upos-sz-mirrorcosov.bilivideo.com";
  var PROTO_MAX_DEPTH = 12;

  var DEFAULTS = {
    hostOverseaVideo: AUTO,
    hostBStar: AUTO,
    hostPcdn: AUTO,
    hostMcdn: MCDN_PROXY_HOST,
    preferHk: false,
    debug: false
  };

  var CFG_ALIASES = {
    host_oversea_video: "hostOverseaVideo",
    host_oversea: "hostOverseaVideo",
    host_bstar: "hostBStar",
    host_pcdn: "hostPcdn",
    host_mcdn: "hostMcdn",
    prefer_hk: "preferHk"
  };

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
  var PROTO_ANCHORS = [
    ".bilivideo.com", ".bilivideo.cn", ".bilivideo.net", ".akamaized.net"
  ];

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
    cfg.hostOverseaVideo = cleanHost(cfg.hostOverseaVideo) || DEFAULTS.hostOverseaVideo;
    cfg.hostBStar = cleanHost(cfg.hostBStar) || DEFAULTS.hostBStar;
    cfg.hostPcdn = cleanHost(cfg.hostPcdn) || DEFAULTS.hostPcdn;
    cfg.hostMcdn = cleanHost(cfg.hostMcdn) || DEFAULTS.hostMcdn;
    cfg.preferHk = asBool(cfg.preferHk, DEFAULTS.preferHk);
    cfg.debug = asBool(cfg.debug, DEFAULTS.debug);
    return cfg;
  }

  // ---- 测速排名（与 bili-speedtest.js 共用） --------------------------------

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

  // 与请求侧同一条规则：开了 preferHk 就取排名里第一个香港节点，没有就退回全场第一。
  function isHkHost(host) {
    return /^cn-hk-eq-/.test(String(host == null ? "" : host));
  }

  function resolveTarget(cfg, key) {
    var value = cfg[key];
    if (value && value !== AUTO) return value;
    var rank = loadRank();
    if (!rank) return BOOTSTRAP_HOST;
    if (cfg.preferHk) {
      for (var i = 0; i < rank.ranking.length; i++) {
        if (isHkHost(rank.ranking[i])) return rank.ranking[i];
      }
    }
    return rank.ranking[0];
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

  // ---- 判定（与请求侧同一套，逐条对照 Redirect 的 GET/HEAD 分支） ------------

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
    // 其余镜像（大陆与融合 CDN）：auto 时收敛到测速第一；固定目标时保持上游语义。
    if (/^upos-[a-z0-9-]+\.bilivideo\.(com|cn|net)$/.test(host)) {
      if (cfg.hostPcdn !== AUTO) return null;
      var fast = resolveTarget(cfg, "hostPcdn");
      return fast && fast !== host ? { host: fast, reason: "pcdn-host" } : null;
    }
    return undefined;
  }

  // 与请求侧同一个函数：一条媒体地址该换成什么。返回新 URL 或 null。
  function rewriteOne(raw, cfg) {
    if (typeof raw !== "string" || raw.indexOf("://") === -1) return null;
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
      var cdn = queryParam(query, "cdn");
      var sid = queryParam(query, "sid");
      if (cdn) return moved(buildUrl(scheme, "d1--" + cdn + ".bilivideo.com", "", path, query), host, "d1--" + cdn + ".bilivideo.com", "mcdn-cdn");
      if (sid) return moved(buildUrl(scheme, sid + ".bilivideo.com", "", path, query), host, sid + ".bilivideo.com", "mcdn-sid");
      return null;
    }
    if (port === "4480") {
      var source = cleanHost(queryParam(query, "xy_usource") || "") || resolveTarget(cfg, "hostPcdn");
      return moved(buildUrl("http", source, "", path, query), host, source, "pcdn-upsource");
    }
    if (port === "8000" || port === "8082") return null;
    if (port === "4483" || port === "9102") {
      if (/\.bilivideo\.com$/.test(host)) return null;
      if (queryParam(query, "originalUrl") !== null) return null;
      return moved(buildUrl("http", cfg.hostMcdn, "", "/", "?url=" + encodeURIComponent(raw)),
        host + ":" + port, cfg.hostMcdn, "mcdn-proxy");
    }
    if (port === "9305") {
      var segs = path.split("/").filter(function (s) { return s !== ""; });
      var head = segs.shift();
      if (!head) return null;
      return moved(buildUrl("http", head, "", "/" + segs.join("/"), query), host, head, "pcdn-path");
    }
    return null;
  }

  function moved(url, from, to, reason) {
    return { url: url, from: from, to: to, reason: reason };
  }

  // ---- JSON 层 --------------------------------------------------------------

  function rewriteValue(node, cfg, stats, depth, seen) {
    if (node == null || depth > 20) return node;
    if (typeof node === "string") {
      if (node.indexOf("/upgcxcode/") === -1 && node.indexOf("/v1/resource/") === -1) return node;
      var hit = rewriteOne(node, cfg);
      if (!hit) return node;
      stats.count += 1;
      stats.details.push(hit);
      return hit.url;
    }
    if (typeof node !== "object") return node;
    if (seen.has(node)) return node;
    seen.add(node);
    var i;
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) node[i] = rewriteValue(node[i], cfg, stats, depth + 1, seen);
      return node;
    }
    var keys = Object.keys(node);
    for (i = 0; i < keys.length; i++) node[keys[i]] = rewriteValue(node[keys[i]], cfg, stats, depth + 1, seen);
    return node;
  }

  // ---- protobuf / gRPC 层 ---------------------------------------------------

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

  function int32Bytes(value) {
    return [
      Math.floor(value / 16777216) % 256,
      Math.floor(value / 65536) % 256,
      Math.floor(value / 256) % 256,
      value % 256
    ];
  }

  function bytesToString(buf, start, end) {
    var s = "";
    for (var i = start; i < end; i++) s += String.fromCharCode(buf[i]);
    return s;
  }

  // 一段 length-delimited payload：先当字符串看有没有媒体地址，有就按 UTF-8 重写。
  function swapInPayload(buf, start, end, cfg, stats) {
    var text = bytesToString(buf, start, end);
    if (text.indexOf("/upgcxcode/") === -1 && text.indexOf("/v1/resource/") === -1) return null;
    var hit = rewriteOne(text, cfg);
    if (!hit) return null;
    stats.count += 1;
    stats.details.push(hit);
    var out = [];
    for (var i = 0; i < hit.url.length; i++) {
      var c = hit.url.charCodeAt(i);
      if (c > 255) return null;                                // 非 ASCII 不动，宁可放过
      out.push(c);
    }
    return out;
  }

  // 递归重建：valid = 这段字节确实是合法 message；out 非空 = 里面发生了替换。
  function walkMessage(buf, start, end, cfg, stats, depth) {
    var invalid = { valid: false, out: null };
    if (depth > PROTO_MAX_DEPTH) return invalid;
    var pos = start;
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
        var payStart = len.next;
        var payEnd = payStart + len.value;
        if (payEnd > end) return invalid;

        var sub = walkMessage(buf, payStart, payEnd, cfg, stats, depth + 1);
        var replaced = sub.valid ? sub.out : swapInPayload(buf, payStart, payEnd, cfg, stats);
        if (replaced) {
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

  // gRPC body 是帧序列：1 字节压缩标志 + 4 字节大端长度 + 消息。
  // 压缩帧解开改写后按"未压缩帧"（flag=0）发回 —— Surge 只有 ungzip，压不回去。
  function rewriteGrpcBody(buf, cfg, stats) {
    var pos = 0;
    var segs = [];
    var frames = 0;
    var compressed = 0;
    var unzipped = 0;

    while (pos + 5 <= buf.length) {
      var flag = buf[pos];
      var len = buf[pos + 1] * 16777216 + buf[pos + 2] * 65536 + buf[pos + 3] * 256 + buf[pos + 4];
      var payEnd = pos + 5 + len;
      if (payEnd > buf.length) return { out: null, frames: frames, compressed: compressed, unzipped: 0, framed: false };
      frames += 1;

      var sub = null;
      if (flag === 0) {
        sub = walkMessage(buf, pos + 5, payEnd, cfg, stats, 0);
        if (sub.out) {
          var nl = int32Bytes(sub.out.length);
          segs.push(0);
          for (var a = 0; a < 4; a++) segs.push(nl[a]);
          for (a = 0; a < sub.out.length; a++) segs.push(sub.out[a]);
          pos = payEnd;
          continue;
        }
      } else {
        compressed += 1;
        var plain = gunzipPayload(buf, pos + 5, payEnd);
        var subC = plain ? walkMessage(plain, 0, plain.length, cfg, stats, 0) : null;
        if (subC && subC.out) {
          var nlC = int32Bytes(subC.out.length);
          segs.push(0);
          for (var b = 0; b < 4; b++) segs.push(nlC[b]);
          for (b = 0; b < subC.out.length; b++) segs.push(subC.out[b]);
          unzipped += 1;
          pos = payEnd;
          continue;
        }
      }
      for (var q = pos; q < payEnd; q++) segs.push(buf[q]);
      pos = payEnd;
    }

    if (!stats.count) return { out: null, frames: frames, compressed: compressed, unzipped: 0, framed: pos === buf.length };
    return {
      out: new Uint8Array(segs), frames: frames, compressed: compressed,
      unzipped: unzipped, framed: pos === buf.length
    };
  }

  // ---- 计数 / 取样 -----------------------------------------------------------

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

  function recordResult(kind, stats) {
    var state = loadStats();
    state.calls += 1;
    state.rewrites += stats.count;
    for (var i = 0; i < stats.details.length; i++) {
      var d = stats.details[i];
      state.reasons[d.reason] = (state.reasons[d.reason] || 0) + 1;
    }
    if (stats.details.length) {
      var last = stats.details[stats.details.length - 1];
      state.last = { reason: reasonLabel(last.reason), from: last.from, to: last.to, at: Date.now() };
    }
    if (kind) state.kind = kind;
    writeStore(K_STATS, JSON.stringify(state));
  }

  function reasonLabel(reason) {
    var labels = {
      "oversea-video": "港澳台",
      "bstar": "国际版",
      "pcdn-host": "PCDN换主机",
      "mcdn-port": "MCDN换端口",
      "mcdn-cdn": "MCDN cdn参数",
      "mcdn-sid": "MCDN sid参数",
      "mcdn-proxy": "MCDN代理包裹",
      "pcdn-upsource": "PCDN回原节点",
      "pcdn-path": "PCDN路径内主机"
    };
    return labels[reason] || reason;
  }

  // 测速样本：playurl 里第一条签名分片就是最好的探测目标，测速脚本下一轮会用它。
  function saveSampleFrom(stats) {
    for (var i = 0; i < stats.details.length; i++) {
      var url = stats.details[i].orig || null;
      if (url) return writeStore(K_SAMPLE, JSON.stringify({ at: Date.now(), url: url }));
    }
    return false;
  }

  function runResponse(cfg) {
    var stats = { count: 0, details: [] };
    try {
      var body = $response && $response.body;
      if (body == null) return done();

      if (typeof body !== "string" && typeof body.length === "number") {
        var bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
        var gres = rewriteGrpcBody(bytes, cfg, stats);
        recordResult("grpc", stats);
        if (cfg.debug) {
          log("grpc: 帧" + gres.frames + " 改写" + stats.count +
            (gres.compressed ? " 压缩" + gres.compressed : "") +
            (gres.unzipped ? " 解压" + gres.unzipped : "") + (gres.framed ? "" : " 非帧"));
        }
        if (gres.out) {
          var headers = {};
          var src = ($response && $response.headers) || {};
          for (var k in src) {
            if (Object.prototype.hasOwnProperty.call(src, k)) headers[k] = src[k];
          }
          delete headers["Content-Length"];
          delete headers["content-length"];
          delete headers["Content-Encoding"];
          delete headers["content-encoding"];
          return done({ body: gres.out, headers: headers });
        }
        return done();
      }

      var parsed = safeParse(body);
      if (!parsed || (body.indexOf("/upgcxcode/") === -1 && body.indexOf("/v1/resource/") === -1)) {
        recordResult("json", stats);
        return done();
      }
      rewriteValue(parsed, cfg, stats, 0, new Set());
      recordResult("json", stats);
      if (cfg.debug) log("json: 改写" + stats.count);
      if (stats.count) return done({ body: JSON.stringify(parsed) });
      return done();
    } catch (e) {
      log("response: failed, passing through (" + (e && e.message) + ")");
      done();
    }
  }

  if (typeof $response !== "undefined" && $response) {
    runResponse(loadConfig());
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
      K_SAMPLE: K_SAMPLE,
      parseArgument: parseArgument,
      loadConfig: loadConfig,
      loadRank: loadRank,
      isHkHost: isHkHost,
      resolveTarget: resolveTarget,
      parseUrl: parseUrl,
      buildUrl: buildUrl,
      queryParam: queryParam,
      classifyHost: classifyHost,
      rewriteOne: rewriteOne,
      rewriteValue: rewriteValue,
      rewriteGrpcBody: rewriteGrpcBody
    };
  }
})();
