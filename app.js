/* StockScan — offline-first warehouse stock-count capture.
   Local-first: every scan is saved to IndexedDB immediately (survives no-wifi/reboot).
   Bonus layer: push the batch to a laptop receiver over wifi when reachable. */
"use strict";

// ---------- tiny DOM helpers ----------
const $ = (s) => document.querySelector(s);
const el = {};
["video","reticle","scanhint","camerr","camerrmsg","torchBtn","manualBtn","manualBtn2","retryCam",
 "qpid","qsub","dupwarn","qval","qminus","qplus","pad","qcancel","qsave",
 "lbody","syncBtn","syncBtn2","listBtn","backScan","exportJson","exportCsv","setLaptop","clearBatch",
 "cntBadge","pendBadge","modal","msheet","toast","installBtn"].forEach(id => el[id] = document.getElementById(id));

// ---------- IndexedDB ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("stockscan", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("records")) d.createObjectStore("records", { keyPath: "id", autoIncrement: true });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "k" });
      };
      r.onsuccess = () => { DB.db = r.result; res(DB.db); };
      r.onerror = () => rej(r.error);
    });
  },
  _s(store, mode) { return DB.db.transaction(store, mode).objectStore(store); },
  _p(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); },
  add(rec) { return DB._p(DB._s("records", "readwrite").add(rec)); },
  put(rec) { return DB._p(DB._s("records", "readwrite").put(rec)); },
  del(id) { return DB._p(DB._s("records", "readwrite").delete(id)); },
  all() { return DB._p(DB._s("records", "readonly").getAll()).then(r => r || []); },
  clearRecords() { return DB._p(DB._s("records", "readwrite").clear()); },
  getMeta(k) { return DB._p(DB._s("meta", "readonly").get(k)).then(r => (r ? r.v : undefined)); },
  setMeta(k, v) { return DB._p(DB._s("meta", "readwrite").put({ k, v })); }
};

// ---------- state ----------
let records = [];
let meta = { batchId: null, startedAt: null, laptopUrl: "" };
let currentView = "scanner";
let currentTag = null;
let editingId = null;

// ---------- camera + scanning ----------
let stream = null, track = null, scanning = false, usingDetector = false, detector = null;
let lastCode = "", lastCodeT = 0, lastScanT = 0, torchOn = false;
const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    el.video.srcObject = stream;
    await el.video.play();
    track = stream.getVideoTracks()[0];
    el.camerr.style.display = "none";
    if ("BarcodeDetector" in window) {
      try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); usingDetector = true; }
      catch (e) { usingDetector = false; }
    }
    scanning = true;
    requestAnimationFrame(scanLoop);
  } catch (e) {
    showCamErr(e && e.message ? e.message : String(e));
  }
}
function stopCamera() {
  scanning = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; track = null; }
}
function showCamErr(msg) {
  el.camerr.style.display = "flex";
  el.camerrmsg.textContent = msg + " — on a phone/tablet the page must be opened over HTTPS for the camera to work.";
}

async function scanLoop() {
  if (!scanning) return;
  const now = performance.now();
  if (now - lastScanT > 150 && el.video.readyState >= 2) {
    lastScanT = now;
    let text = null;
    try {
      if (usingDetector) {
        const codes = await detector.detect(el.video);
        if (codes && codes.length) text = codes[0].rawValue;
      } else {
        const w = el.video.videoWidth, h = el.video.videoHeight;
        if (w && h) {
          scanCanvas.width = w; scanCanvas.height = h;
          scanCtx.drawImage(el.video, 0, 0, w, h);
          const img = scanCtx.getImageData(0, 0, w, h);
          const r = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
          if (r) text = r.data;
        }
      }
    } catch (e) { /* transient */ }
    if (text) onDetect(text);
  }
  requestAnimationFrame(scanLoop);
}

function onDetect(text) {
  if (currentView !== "scanner") return;
  const now = performance.now();
  if (text === lastCode && now - lastCodeT < 2500) return;
  const tag = parseTag(text);
  if (!tag) { flashHint("Not an Odoo product QR", true); return; }
  lastCode = text; lastCodeT = now;
  el.reticle.classList.add("hit");
  setTimeout(() => el.reticle.classList.remove("hit"), 400);
  beep(); if (navigator.vibrate) navigator.vibrate(80);
  if (tag.unknownModel) flashHint("Unusual model: " + tag.model, true);
  openQty(tag);
}

let hintTimer = null;
function flashHint(msg, warn) {
  el.scanhint.textContent = msg;
  el.scanhint.style.color = warn ? "#ffd9b8" : "#fff";
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { el.scanhint.textContent = "Point at a QR tag"; el.scanhint.style.color = "#fff"; }, 1800);
}

async function toggleTorch() {
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.torch) { toast("No torch on this camera"); return; }
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); el.torchBtn.style.color = torchOn ? "#ff7a1a" : ""; }
  catch (e) { toast("Torch failed"); }
}

// ---------- views ----------
function showView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === name));
  if (name === "list") renderList();
}

// ---------- qty entry ----------
function setQval(n) { el.qval.value = String(Math.max(0, n | 0)); }
function getQval() { return Math.max(0, parseInt(el.qval.value, 10) || 0); }

function openQty(tag) {
  currentTag = tag; editingId = null;
  el.qpid.textContent = tag.productId;
  el.qsub.textContent = tag.model + "  @  " + tag.host;
  const existing = records.find(r => r.productId === tag.productId);
  if (existing) {
    editingId = existing.id;
    el.dupwarn.style.display = "block";
    el.dupwarn.textContent = "Already in this batch (qty " + existing.qty + "). Saving overwrites it.";
    setQval(existing.qty);
  } else {
    el.dupwarn.style.display = "none";
    setQval(0);
  }
  showView("qty");
}

function openEdit(rec) {
  currentTag = { productId: rec.productId, model: rec.model, rawUrl: rec.rawUrl, host: rec.host };
  editingId = rec.id;
  el.qpid.textContent = rec.productId;
  el.qsub.textContent = rec.model + "  @  " + rec.host;
  el.dupwarn.style.display = "none";
  setQval(rec.qty);
  showView("qty");
}

async function saveQty() {
  const qty = getQval();
  if (editingId != null) {
    const rec = records.find(r => r.id === editingId);
    if (rec) { rec.qty = qty; rec.synced = false; rec.scannedAt = Date.now(); await DB.put(rec); }
  } else {
    await DB.add({
      productId: currentTag.productId, model: currentTag.model, rawUrl: currentTag.rawUrl,
      host: currentTag.host, qty, mode: "count", synced: false, scannedAt: Date.now()
    });
  }
  await refresh();
  toast("Saved " + currentTag.productId + " = " + qty);
  lastCode = ""; // allow an immediate re-scan of the same tag if needed
  showView("scanner");
  trySync(true); // best-effort auto-sync, silent
}

// ---------- list / export ----------
function fmtTime(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
function renderList() {
  const sorted = records.slice().sort((a, b) => b.scannedAt - a.scannedAt);
  if (!sorted.length) {
    el.lbody.innerHTML = '<div class="empty">No counts yet.<br>Scan a tag to start the batch.</div>';
    return;
  }
  el.lbody.innerHTML = sorted.map(r =>
    '<div class="rec ' + (r.synced ? "synced" : "") + '" data-id="' + r.id + '">' +
      '<span class="sdot"></span>' +
      '<div><div class="rid">#' + r.productId + '</div>' +
      '<div class="rmeta">' + r.model.replace("product.", "") + " · " + fmtTime(r.scannedAt) + (r.synced ? " · synced" : " · pending") + '</div></div>' +
      '<div class="rqty">' + r.qty + '</div>' +
      '<button class="del" data-del="' + r.id + '">&times;</button>' +
    '</div>'
  ).join("");
}
function recordsToCsv() {
  const head = "productId,qty,model,host,scannedAt,rawUrl";
  const rows = records.map(r =>
    [r.productId, r.qty, r.model, r.host, new Date(r.scannedAt).toISOString(), '"' + (r.rawUrl || "").replace(/"/g, '""') + '"'].join(","));
  return [head].concat(rows).join("\r\n");
}
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportJson() {
  if (!records.length) return toast("Nothing to export");
  download("stockscan-" + meta.batchId + ".json",
    JSON.stringify({ batchId: meta.batchId, startedAt: meta.startedAt, exportedAt: Date.now(), records }, null, 2),
    "application/json");
}
function exportCsv() {
  if (!records.length) return toast("Nothing to export");
  download("stockscan-" + meta.batchId + ".csv", recordsToCsv(), "text/csv");
}

// ---------- sync to laptop ----------
async function trySync(silent) {
  const url = (meta.laptopUrl || "").trim();
  const pending = records.filter(r => !r.synced);
  if (!url) { if (!silent) askLaptop(); return; }
  if (!pending.length) { if (!silent) toast("Nothing pending"); return; }
  if (!navigator.onLine) { if (!silent) toast("Offline — will sync when on wifi"); return; }
  try {
    const res = await fetch(url.replace(/\/$/, "") + "/upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: meta.batchId, records: pending })
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    await res.json().catch(() => ({}));
    for (const r of pending) { r.synced = true; await DB.put(r); }
    await refresh();
    toast((silent ? "Auto-synced " : "Synced ") + pending.length + " to laptop");
  } catch (e) {
    if (!silent) toast("Sync failed: " + (e.message || e));
  }
}

// ---------- modal / toast ----------
function showModal(html) { el.msheet.innerHTML = html; el.modal.classList.add("show"); }
function closeModal() { el.modal.classList.remove("show"); }
let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg; el.toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2000);
}

function askLaptop() {
  const cur = meta.laptopUrl || "https://192.168.1.208:8810";
  showModal(
    "<h3>Laptop receiver address</h3>" +
    "<p>Your laptop's address on the same wifi (find its IP with <b>ipconfig</b>). The receiver listens on port 8810 over <b>https</b> — install the receiver's CA cert on this tablet once so it's trusted.</p>" +
    '<input id="lap" value="' + cur + '" placeholder="https://192.168.1.x:8810">' +
    '<div class="mbtns"><button class="ghost" id="lcancel">Cancel</button><button class="ok" id="lsave">Save</button></div>'
  );
  $("#lcancel").onclick = closeModal;
  $("#lsave").onclick = async () => { meta.laptopUrl = $("#lap").value.trim(); await DB.setMeta("laptopUrl", meta.laptopUrl); closeModal(); toast("Saved laptop address"); };
}

function askManual() {
  showModal(
    "<h3>Enter product ID</h3><p>Use this if the camera can't read a tag. Type the Odoo product ID number.</p>" +
    '<input id="mid" inputmode="numeric" placeholder="e.g. 30047">' +
    '<div class="mbtns"><button class="ghost" id="mcancel">Cancel</button><button class="ok" id="mok">Next</button></div>'
  );
  $("#mcancel").onclick = closeModal;
  $("#mok").onclick = () => {
    const v = ($("#mid").value || "").trim();
    if (!/^\d+$/.test(v)) return toast("Numbers only");
    closeModal();
    openQty({ productId: Number(v), model: "product.template", rawUrl: "(manual)", host: "manual" });
  };
}

function confirmClear() {
  const pending = records.filter(r => !r.synced).length;
  showModal(
    "<h3>Clear batch?</h3>" +
    "<p>" + records.length + " record(s) will be removed from this tablet." +
    (pending ? " <b style='color:#ff7a1a'>" + pending + " are NOT yet synced/exported.</b>" : " All are synced.") +
    " This cannot be undone.</p>" +
    '<div class="mbtns"><button class="ghost" id="ccancel">Cancel</button><button class="ok" id="cok">Clear</button></div>'
  );
  $("#ccancel").onclick = closeModal;
  $("#cok").onclick = async () => {
    await DB.clearRecords();
    meta.batchId = newBatchId(); meta.startedAt = Date.now();
    await DB.setMeta("batchId", meta.batchId); await DB.setMeta("startedAt", meta.startedAt);
    await refresh(); closeModal(); toast("Batch cleared"); showView("scanner");
  };
}

// ---------- misc ----------
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
    const ac = beep._ac || (beep._ac = new Ctx());
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.14);
    o.start(); o.stop(ac.currentTime + 0.15);
  } catch (e) {}
}

let wakeLock = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
function newBatchId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function refresh() {
  records = await DB.all();
  const pending = records.filter(r => !r.synced).length;
  el.cntBadge.textContent = records.length;
  el.pendBadge.textContent = pending;
  el.pendBadge.hidden = pending === 0;
  if (currentView === "list") renderList();
}

// ---------- wire up ----------
function buildPad() {
  const keys = ["1","2","3","4","5","6","7","8","9","C","0","<"];
  el.pad.innerHTML = keys.map(k => '<button data-k="' + k + '">' + k + "</button>").join("");
  el.pad.onclick = (e) => {
    const k = e.target && e.target.getAttribute("data-k"); if (!k) return;
    let v = el.qval.value;
    if (k === "C") v = "0";
    else if (k === "<") v = v.length > 1 ? v.slice(0, -1) : "0";
    else { v = (v === "0" ? "" : v) + k; if (v.length > 6) v = v.slice(0, 6); }
    el.qval.value = v === "" ? "0" : v;
  };
}

function wire() {
  el.torchBtn.onclick = toggleTorch;
  el.manualBtn.onclick = askManual;
  el.manualBtn2.onclick = askManual;
  el.retryCam.onclick = startCamera;
  el.qminus.onclick = () => setQval(getQval() - 1);
  el.qplus.onclick = () => setQval(getQval() + 1);
  el.qcancel.onclick = () => { lastCode = ""; showView("scanner"); };
  el.qsave.onclick = saveQty;
  el.listBtn.onclick = () => showView("list");
  el.backScan.onclick = () => { lastCode = ""; showView("scanner"); };
  el.syncBtn.onclick = () => trySync(false);
  el.syncBtn2.onclick = () => trySync(false);
  el.setLaptop.onclick = askLaptop;
  el.exportJson.onclick = exportJson;
  el.exportCsv.onclick = exportCsv;
  el.clearBatch.onclick = confirmClear;
  el.modal.onclick = (e) => { if (e.target === el.modal) closeModal(); };
  el.lbody.onclick = (e) => {
    const del = e.target.getAttribute && e.target.getAttribute("data-del");
    if (del) { DB.del(Number(del)).then(refresh).then(() => toast("Deleted")); return; }
    const row = e.target.closest && e.target.closest(".rec");
    if (row) { const rec = records.find(r => r.id === Number(row.getAttribute("data-id"))); if (rec) openEdit(rec); }
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });
  window.addEventListener("online", () => trySync(true));

  // installable PWA: surface a clear Install button instead of hunting Chrome's menu
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    el.installBtn.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    el.installBtn.hidden = true;
    toast("Installed! Open StockScan from your home screen.");
  });
  el.installBtn.onclick = async () => {
    if (!deferredPrompt) { toast("Already installed, or use Chrome menu > Add to Home screen"); return; }
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice && choice.outcome === "accepted") el.installBtn.hidden = true;
  };
}
let deferredPrompt = null;

async function init() {
  buildPad();
  wire();
  await DB.open();
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
  meta.batchId = (await DB.getMeta("batchId")) || newBatchId();
  meta.startedAt = (await DB.getMeta("startedAt")) || Date.now();
  meta.laptopUrl = (await DB.getMeta("laptopUrl")) || "";
  await DB.setMeta("batchId", meta.batchId);
  await DB.setMeta("startedAt", meta.startedAt);
  await refresh();
  keepAwake();
  startCamera();
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) {}
  }
}
init();
