// BiliFastCDN · 测速与面板 —— 两个后端（bili-cdn.js 请求侧 / bili-playurl.js 响应侧）共用这一个文件。
// 职责：cron 里用真实签名分片做 Range 请求测吞吐，把排名写进 $persistentStore；面板读排名与计数并渲染。
// 排名只回答一个问题：候选池里哪个主机现在最快。判定规则（哪个分类换到谁）仍在两个后端里。

(function () {
  "use strict";

  var TAG = "[BiliFastCDN] ";
  var VERSION = "1.1.0";

  var K_RANK = "bili_fast_cdn.rank.v2";
  var K_SAMPLE = "bili_fast_cdn.sample.v1";
  var K_STATS = "bili_fast_cdn.stats.v1";

  // 候选池：海外镜像优先。Akamai 不列入 —— 它对 upos 签名路径返回 403，测不出结果。
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

  var DEFAULTS = {
    notify: true,
    debug: false,
    rankTtlMs: 6 * 60 * 60 * 1000,
    sampleTtlMs: 90 * 60 * 1000,
    // 注意单位：Surge $httpClient 的 timeout 是秒，其余 TTL 是毫秒。
    probeTimeout: 4,
    probeBytes: 1024 * 1024
  };

  var MAX_LOGGED_SAMPLES = 8;

  var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

  function asNumber(value, fallback) {
    var n = parseFloat(value);
    return isFinite(n) && n > 0 ? n : fallback;
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
      if (Object.prototype.hasOwnProperty.call(merged, key)) cfg[key] = merged[key];
    }
    cfg.notify = asBool(cfg.notify, DEFAULTS.notify);
    cfg.debug = asBool(cfg.debug, DEFAULTS.debug);
    cfg.rankTtlMs = asNumber(cfg.rankTtlMs, DEFAULTS.rankTtlMs);
    cfg.sampleTtlMs = asNumber(cfg.sampleTtlMs, DEFAULTS.sampleTtlMs);
    cfg.probeTimeout = asNumber(cfg.probeTimeout, DEFAULTS.probeTimeout);
    cfg.probeBytes = asNumber(cfg.probeBytes, DEFAULTS.probeBytes);
    return cfg;
  }

  function cleanHost(host) {
    var t = String(host == null ? "" : host).trim();
    if (!t || t.indexOf("{{{") !== -1) return "";
    return t.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").replace(/:\d+$/, "").toLowerCase();
  }

  function swapHost(rawUrl, host) {
    if (typeof rawUrl !== "string") return null;
    var idx = rawUrl.indexOf("://");
    var start = idx === -1 ? 2 : idx + 3;
    var cut = rawUrl.length;
    for (var i = start; i < rawUrl.length; i++) {
      var c = rawUrl.charAt(i);
      if (c === "/" || c === "?" || c === "#") { cut = i; break; }
    }
    var scheme = idx === -1 ? "https" : rawUrl.slice(0, idx + 3);
    return scheme + cleanHost(host) + rawUrl.slice(cut);
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

  function loadRank(cfg) {
    var j = safeParse(readStore(K_RANK));
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
      fresh: (Date.now() - (j.at || 0)) < (cfg ? cfg.rankTtlMs : DEFAULTS.rankTtlMs),
      ranking: hosts,
      samples: j.samples || [],
      rejected: j.rejected || []
    };
  }

  function bestHost() {
    var rank = loadRank(loadConfig());
    return rank ? rank.ranking[0] : DEFAULT_HOST;
  }

  // ---- 测速 -----------------------------------------------------------------

  function saveSample(url) {
    if (!url) return;
    writeStore(K_SAMPLE, JSON.stringify({ at: Date.now(), url: url }));
  }

  function loadSample(cfg) {
    var j = safeParse(readStore(K_SAMPLE));
    if (!j || typeof j.url !== "string" || !j.url) return null;
    if ((Date.now() - (j.at || 0)) > cfg.sampleTtlMs) return null;
    return j.url;
  }

  // 没有签名样本时，自己去公开接口取一个（网页版 playurl，签名是 upos 那套）。
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
        if (list[i] && list[i].bvid && list[i].cid) { bvid = list[i].bvid; cid = list[i].cid; break; }
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

  function findSample(root) {
    var best = null;
    (function walk(node, depth) {
      if (best || node == null || depth > 20) return;
      if (typeof node === "string") {
        if (node.indexOf("/upgcxcode/") === -1 && node.indexOf("/v1/resource/") === -1) return;
        if (!/\.(m4s|mp4|flv)(?:$|[?#])/i.test(node)) return;
        if (/\.mcdn\.bilivideo\.|proxy-tf-all-ws\./.test(node)) return;
        best = node;
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
      if (err || status < 200 || status >= 300 || !data) return cb({ host: host, ok: false, ms: ms, mbps: 0, status: status });
      // 403/404 的 HTML 错误页也会带 2xx 之外的码，但有的边缘返回 200 + HTML，这里再挡一层。
      if (data.charAt(0) === "<") return cb({ host: host, ok: false, ms: ms, mbps: 0, status: status });
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

  function saveRank(ranked, via, results) {
    var payload = { at: Date.now(), via: via, ranking: [], samples: [], rejected: [] };
    for (var i = 0; i < ranked.length; i++) {
      payload.ranking.push(ranked[i].host);
      payload.samples.push({
        host: ranked[i].host,
        mbps: Math.round(ranked[i].mbps * 100) / 100,
        ms: ranked[i].ms
      });
    }
    // 被否掉的候选要留痕：测速时 403 的节点不可能是好目标，用户得看得见。
    var all = results || [];
    for (i = 0; i < all.length; i++) {
      if (all[i] && !all[i].ok) payload.rejected.push({ host: all[i].host, status: all[i].status || 0 });
    }
    writeStore(K_RANK, JSON.stringify(payload));
  }

  function logSamples(results) {
    for (var i = 0; i < results.length && i < MAX_LOGGED_SAMPLES; i++) {
      var r = results[i];
      log("probe: " + r.host + " status=" + r.status + " " + r.ms + "ms " +
        (r.ok ? (r.mbps ? r.mbps.toFixed(2) + "Mbps" : "latency-only") : "rejected"));
    }
  }

  function notifyBest(ranked, via, cfg) {
    var limit = cfg.debug ? ranked.length : 3;
    var lines = [];
    for (var i = 0; i < ranked.length && i < limit; i++) {
      lines.push(shorten(ranked[i].host) + " " + ranked[i].mbps.toFixed(1) + " Mbps / " + ranked[i].ms + "ms");
    }
    if (via !== "sample") lines.push("仅延迟测速：播放一次视频后会自动做吞吐测速");
    try { $notification.post("BiliFastCDN 测速完成", "最快 " + shorten(ranked[0].host), lines.join("\n")); } catch (e) {}
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
      log("probe: via=" + via + " best=" + ranked[0].host + " " + ranked[0].mbps.toFixed(2) +
        "Mbps " + ranked[0].ms + "ms");
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
    var cached = loadRank(cfg);
    if (cached && cached.fresh) {
      log("cron: ranking still fresh (" + Math.round((Date.now() - cached.at) / 60000) + "min), skip");
      return done();
    }
    probeRound(cfg, function (ranked) {
      if (!ranked) {
        log("cron: nobody answered, keeping " + (cached ? "the previous ranking" : "the default host"));
        return done();
      }
      if (cfg.notify) notifyBest(ranked, null, cfg);
      done();
    });
  }

  // ---- 面板 -----------------------------------------------------------------

  function shorten(host) {
    return String(host)
      .replace(/\.bilivideo\.(com|cn|net)$/, "")
      .replace(/\.akamaized\.net$/, "")
      .replace(/^upos-/, "");
  }

  function rejectedTail(rejected) {
    if (!rejected || !rejected.length) return "";
    var parts = [];
    for (var i = 0; i < rejected.length && i < 2; i++) {
      parts.push(shorten(rejected[i].host) + (rejected[i].status ? "(" + rejected[i].status + ")" : ""));
    }
    if (rejected.length > 2) parts.push("+" + (rejected.length - 2));
    return " · 剔除 " + parts.join(" ");
  }

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

  function runPanel(cfg) {
    try {
      var rank = loadRank(cfg);
      var state = loadStats();
      var lines = [];
      var style = "info";

      if (rank && rank.ranking.length) {
        var best = rank.samples && rank.samples.length ? rank.samples[0] : null;
        var rate = best && best.mbps ? best.mbps.toFixed(1) + " Mbps" : (best ? "延迟 " + best.ms + "ms" : "");
        var ageMin = Math.round((Date.now() - rank.at) / 60000);
        lines.push("最快 " + shorten(rank.ranking[0]) + (rate ? " · " + rate : ""));
        lines.push("测速 " + (ageMin < 1 ? "刚刚" : ageMin + " 分钟前") + " · " + rank.ranking.length + " 个节点" +
          rejectedTail(rank.rejected));
      } else {
        lines.push(shorten(DEFAULT_HOST) + "（兜底，尚未测速）");
        lines.push("点刷新按钮立即测速");
      }

      lines.push("改写 命中" + state.calls + " 改写" + state.rewrites);
      if (state.last) {
        lines.push("最近 " + (state.last.reason || "") + "：" +
          shorten(state.last.from) + " → " + shorten(state.last.to));
      }
      if (rank && rank.ranking.length && state.rewrites > 0) style = "good";
      else if (state.calls > 0) lines.push("有流量但无需改写");
      else if (rank && rank.ranking.length) lines.push("尚未收到媒体请求");

      done({ title: "B站CDN v" + VERSION, content: lines.join("\n"), style: style });
    } catch (e) {
      log("panel: failed (" + (e && e.message) + ")");
      done({ title: "B站CDN v" + VERSION, content: "渲染失败：" + (e && e.message), style: "error" });
    }
  }

  // ---- 入口 -----------------------------------------------------------------

  if (typeof $input !== "undefined" && $input && $input.purpose === "panel") {
    var panelCfg = loadConfig();
    // 点卡片刷新按钮 = 立即重测；自动刷新只读缓存。
    if (typeof $trigger !== "undefined" && $trigger === "button") {
      log("panel: refresh tapped, starting a probe round");
      return probeRound(panelCfg, function () { runPanel(panelCfg); });
    }
    runPanel(panelCfg);
  } else {
    try { runCron(loadConfig()); } catch (e) { log("probe: failed (" + (e && e.message) + ")"); done(); }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      VERSION: VERSION,
      DEFAULTS: DEFAULTS,
      CANDIDATE_POOL: CANDIDATE_POOL,
      DEFAULT_HOST: DEFAULT_HOST,
      K_RANK: K_RANK,
      K_SAMPLE: K_SAMPLE,
      K_STATS: K_STATS,
      parseArgument: parseArgument,
      loadConfig: loadConfig,
      cleanHost: cleanHost,
      swapHost: swapHost,
      throughputMbps: throughputMbps,
      rankSamples: rankSamples,
      loadRank: loadRank,
      saveRank: saveRank,
      loadSample: loadSample,
      saveSample: saveSample,
      findSample: findSample
    };
  }
})();
