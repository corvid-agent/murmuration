/* MURMURATION - quiet-round pot board. Reads the app's global state from
   the TestNet indexer once appId > 0 in deploy.json. Live first; on feed
   failure falls back to the last good snapshot (STALE) rather than
   guessing. TestNet only. Read-only. No wallet. No keys. */
(() => {
  const INDEXER = "https://testnet-idx.algonode.cloud";
  const ALGOD = "https://testnet-api.algonode.cloud";
  const EXPLORER = "https://testnet.explorer.perawallet.app/application/";
  const CONTRACT_SRC =
    "https://github.com/corvid-agent/murmuration/blob/main/smart_contracts/murmuration/contract.py";
  const DEFAULT_KEEPER = 769891898;
  const ROUND_SEC = 2.8;
  const REFRESH_MS = 30000;
  const SNAPSHOT_KEY = "murmuration:snapshot";

  function b64utf8(b64) {
    try { return atob(b64); } catch { return ""; }
  }

  function readGlobal(state, name) {
    if (!Array.isArray(state)) return null;
    for (const kv of state) {
      if (b64utf8(kv.key) !== name) continue;
      if (kv.value && kv.value.type === 2) return { kind: "uint", v: kv.value.uint };
      if (kv.value && kv.value.type === 1) return { kind: "bytes", v: kv.value.bytes };
      return null;
    }
    return null;
  }

  async function fetchJson(url, noStore) {
    const opts = { headers: { Accept: "application/json" } };
    if (noStore) opts.cache = "no-store";
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }

  function flaps(el, text) {
    el.replaceChildren();
    for (const ch of String(text)) {
      const d = document.createElement("span");
      d.className = "flap" + (ch === " " ? " blank" : "");
      d.textContent = ch === " " ? " " : ch;
      el.appendChild(d);
    }
  }

  function setStatus(word, cls, subHtml) {
    const el = document.getElementById("status");
    el.className = "flaps big " + cls;
    flaps(el, word.toUpperCase());
    document.getElementById("subhead").innerHTML = subHtml;
    document.title = "MURMURATION — " + word.toUpperCase();
  }

  const STAT_IDS = [
    "stat-flock", "stat-pot", "stat-quiet", "stat-window",
    "stat-lastjoiner", "stat-joinround", "stat-round", "stat-keeper",
  ];

  function fillStats(map) {
    for (const id of STAT_IDS) {
      flaps(document.getElementById(id), map[id] || "—");
    }
  }

  function spanLabel(rounds) {
    const sec = Math.abs(rounds) * ROUND_SEC;
    if (sec < 90) return rounds + "r";
    if (sec < 3600) return "~" + Math.round(sec / 60) + "m";
    if (sec < 86400) return "~" + (sec / 3600).toFixed(1) + "h";
    return "~" + (sec / 86400).toFixed(1) + "d";
  }

  function b64ToAddr(b64) {
    try {
      const bin = atob(b64);
      if (bin.length < 32) return "";
      // base32 the 32-byte public key (no padding) for a short addr read.
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      let bits = 0, value = 0, out = "";
      for (let i = 0; i < 32; i++) {
        value = (value << 8) | bin.charCodeAt(i);
        bits += 8;
        while (bits >= 5) {
          out += alphabet[(value >>> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      return out;
    } catch {
      return "";
    }
  }

  function shortAddr(addr) {
    if (!addr) return "—";
    return addr.slice(0, 6) + "…" + addr.slice(-6);
  }

  function saveSnapshot(snap) {
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch { /* storage unavailable; live-only then */ }
  }

  function loadSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function renderSnapshot(snap) {
    const ageMin = Math.max(0, Math.round((Date.now() - snap.ts) / 60000));
    setStatus("STALE", "gate",
      "feed unreachable · last good read " + ageMin + " min ago: " +
      snap.word + (snap.subText ? " · " + snap.subText : ""));
    fillStats(snap.stats || {});
  }

  let cfgPromise = null;
  function loadConfig() {
    if (!cfgPromise) {
      cfgPromise = fetchJson("./deploy.json", true).then((c) => ({
        appId: Number(c.appId) || 0,
        keeper: Number(c.keeperAppId) || DEFAULT_KEEPER,
        network: c.network || "testnet",
        notes: c.notes || "",
      }));
    }
    return cfgPromise;
  }

  async function tick() {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      setStatus("FEED DOWN", "down",
        "deploy.json unreadable · showing nothing rather than guessing");
      fillStats({});
      return;
    }
    document.getElementById("keeper-meta").textContent =
      cfg.network + " · Arcron keeper " + cfg.keeper;

    if (cfg.appId <= 0) {
      setStatus("NOT DEPLOYED", "gate",
        'contract exists as <a href="' + CONTRACT_SRC + '">source</a> only' +
        " · lights up after TestNet deploy + set_keeper + Arcron registration");
      fillStats({ "stat-keeper": String(cfg.keeper) });
      return;
    }

    let round, gs;
    try {
      const status = await fetchJson(ALGOD + "/v2/status");
      round = status["last-round"];
      const app = await fetchJson(INDEXER + "/v2/applications/" + cfg.appId);
      const params = (app.application && app.application.params) || app.params || {};
      gs = params["global-state"];
    } catch (e) {
      const snap = loadSnapshot();
      if (snap && snap.appId === cfg.appId) {
        renderSnapshot(snap);
      } else {
        setStatus("FEED DOWN", "down",
          "indexer unreachable · no prior snapshot · showing nothing rather than guessing");
        fillStats({ "stat-keeper": String(cfg.keeper) });
      }
      return;
    }

    const keeperApp = readGlobal(gs, "keeper_app");
    const flock = readGlobal(gs, "flock");
    const pot = readGlobal(gs, "pot");
    const lastJoin = readGlobal(gs, "last_join_round");
    const quiet = readGlobal(gs, "quiet_rounds");
    const lastJoiner = readGlobal(gs, "last_joiner");

    const nFlock = flock && flock.kind === "uint" ? flock.v : 0;
    const nPot = pot && pot.kind === "uint" ? pot.v : 0;
    const nJoin = lastJoin && lastJoin.kind === "uint" ? lastJoin.v : 0;
    const nQuiet = quiet && quiet.kind === "uint" ? quiet.v : 0;
    const joinerAddr = lastJoiner && lastJoiner.kind === "bytes"
      ? b64ToAddr(lastJoiner.v) : "";
    const quietSoFar = nFlock > 0 ? Math.max(0, round - nJoin) : 0;
    const quietLeft = nFlock > 0 ? Math.max(0, nQuiet - quietSoFar) : 0;

    const stats = {
      "stat-flock": String(nFlock),
      "stat-pot": (nPot / 1e6).toFixed(3) + " ALGO",
      "stat-quiet": nFlock > 0
        ? String(quietSoFar) + " / " + String(nQuiet) + " (" + spanLabel(quietLeft) + " left)"
        : "—",
      "stat-window": nQuiet > 0 ? String(nQuiet) + " (" + spanLabel(nQuiet) + ")" : "—",
      "stat-lastjoiner": nFlock > 0 ? shortAddr(joinerAddr) : "—",
      "stat-joinround": nJoin > 0 ? String(nJoin) : "—",
      "stat-round": String(round),
      "stat-keeper": keeperApp ? String(keeperApp.v) : "—",
    };
    fillStats(stats);

    const appLink = 'app <a href="' + EXPLORER + cfg.appId + '">' + cfg.appId + "</a>";
    let word, cls, subText;
    if (!keeperApp || keeperApp.v === 0) {
      word = "NO KEEPER"; cls = "gate";
      subText = appLink + " is live but set_keeper has not run yet";
    } else if (nFlock === 0) {
      word = "EMPTY FLOCK"; cls = "gate";
      subText = appLink + " keeper wired · nobody has joined the flock yet";
    } else if (nPot === 0) {
      word = "POT PAID"; cls = "spoken";
      subText = appLink + " the pot flew to " + shortAddr(joinerAddr) +
        " · waiting for the next join";
    } else if (quietSoFar > nQuiet) {
      word = "QUIET"; cls = "down";
      subText = appLink + " silent for " + spanLabel(quietSoFar) +
        " · the next keeper tick pays " + (nPot / 1e6).toFixed(3) +
        " ALGO to " + shortAddr(joinerAddr);
    } else {
      word = "FLOCKING"; cls = "live";
      subText = appLink + " " + nFlock + " joined · pot " +
        (nPot / 1e6).toFixed(3) + " ALGO · pays out after " +
        spanLabel(quietLeft) + " more of silence";
    }
    setStatus(word, cls, subText);

    saveSnapshot({
      appId: cfg.appId,
      ts: Date.now(),
      word: word,
      subText: subText.replace(/<[^>]*>/g, ""),
      stats: stats,
    });
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();
