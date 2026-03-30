// ============================================================
// EndBounce Email Checker Pro v5 - Background Service Worker
// ============================================================
// Features: 30 parallel tabs, error retry queue, unknown status,
// crash recovery, auto-resume, per-email persistence

let BATCH_SIZE = 10;
let CHECK_INTERVAL = 300;
const MAX_RETRIES = 3;
const TAB_LOAD_TIMEOUT = 15000;
const MAX_POLL_ATTEMPTS = 45;
const RETRY_POLL_ATTEMPTS = 35;

let isProcessing = false;
let shouldStop = false;
let results = [];
let currentEmails = [];
let processedCount = 0;
let reusableTabIds = [];
let startTime = null;
let totalProcessed = 0;
let isRestoring = false;
let retryQueue = []; // emails that errored and need retry

// ============================================================
// STATE PERSISTENCE
// ============================================================
function saveState() {
  chrome.storage.local.set({ isProcessing, currentEmails, processedCount, results, BATCH_SIZE, CHECK_INTERVAL, retryQueue });
}
function saveResults() {
  chrome.storage.local.set({ processedCount, results });
}

// ============================================================
// RESTORE STATE
// ============================================================
chrome.runtime.onStartup.addListener(restoreState);
chrome.runtime.onInstalled.addListener(restoreState);

async function restoreState() {
  if (isRestoring || isProcessing) return;
  isRestoring = true;
  try {
    const data = await chrome.storage.local.get(["isProcessing","currentEmails","processedCount","results","BATCH_SIZE","CHECK_INTERVAL","retryQueue"]);
    if (data.results?.length) { results = data.results; }
    if (data.currentEmails) currentEmails = data.currentEmails;
    if (data.processedCount) processedCount = data.processedCount;
    if (data.BATCH_SIZE) BATCH_SIZE = data.BATCH_SIZE;
    if (data.CHECK_INTERVAL) CHECK_INTERVAL = data.CHECK_INTERVAL;
    if (data.retryQueue) retryQueue = data.retryQueue;

    if (data.isProcessing && currentEmails.length > 0 && processedCount < currentEmails.length) {
      isProcessing = true;
      const remaining = currentEmails.length - processedCount;
      updateStatus(`♻️ Resuming: ${processedCount}/${currentEmails.length} done, ${remaining} left`, "info");
      startTime = Date.now();
      totalProcessed = processedCount;
      startProcessing(currentEmails.slice(processedCount));
    } else if (data.isProcessing) {
      isProcessing = false;
      chrome.storage.local.set({ isProcessing: false });
    }
  } catch (e) { console.error("Restore error:", e); }
  isRestoring = false;
}

// ============================================================
// KEEP-ALIVE
// ============================================================
function startHeartbeat() { chrome.alarms.create("hb", { periodInMinutes: 0.4 }); }
function stopHeartbeat() { chrome.alarms.clear("hb"); }
chrome.alarms.onAlarm.addListener(() => { if (isProcessing && results.length > 0) saveResults(); });

// ============================================================
// MESSAGE HANDLER
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "startProcessing") {
    currentEmails = msg.emails;
    results = [];
    processedCount = 0;
    retryQueue = [];
    startTime = Date.now();
    totalProcessed = 0;
    if (msg.batchSize) BATCH_SIZE = Math.min(msg.batchSize, 50);
    if (msg.checkInterval) CHECK_INTERVAL = Math.max(msg.checkInterval, 100);
    saveState();
    sendResponse({ received: true });
    startProcessing(msg.emails);
    return true;
  }
  if (msg.action === "getState") {
    if (results.length === 0 && !isProcessing) {
      chrome.storage.local.get(["results","currentEmails","processedCount","isProcessing","retryQueue"], d => {
        sendResponse({ isProcessing: d.isProcessing||false, emails: d.currentEmails||[], processedCount: d.processedCount||0, results: d.results||[], batchSize: BATCH_SIZE, retryQueue: d.retryQueue||[] });
      });
      return true;
    }
    sendResponse({ isProcessing, emails: currentEmails, processedCount, results, batchSize: BATCH_SIZE, retryQueue });
    return true;
  }
  if (msg.action === "stopProcessing") {
    shouldStop = true; isProcessing = false;
    updateStatus("⏹ Stopping...", "warning");
    chrome.storage.local.set({ isProcessing: false, processedCount, results });
    cleanupTabs();
    sendResponse({ received: true });
    return true;
  }
  if (msg.action === "clearState") {
    results=[]; currentEmails=[]; processedCount=0; retryQueue=[];
    isProcessing=false; shouldStop=true; startTime=null;
    chrome.storage.local.remove(["isProcessing","currentEmails","savedEmails","processedCount","results","retryQueue"]);
    sendResponse({ cleared: true });
    return true;
  }
});

// ============================================================
// MAIN PROCESSING LOOP
// ============================================================
async function startProcessing(emails) {
  if (!emails.length) { isProcessing = false; return; }
  isProcessing = true;
  shouldStop = false;
  startHeartbeat();
  updateStatus(`🚀 Verifying ${emails.length} emails with ${BATCH_SIZE} tabs...`, "info");

  // Main pass
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    if (shouldStop) break;
    const batch = emails.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor((processedCount + i) / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(currentEmails.length / BATCH_SIZE);
    updateStatus(`📦 Batch ${batchNum}/${totalBatches} (${batch.length} emails)`, "info");
    await processBatch(batch);
  }

  // ★ RETRY PASS: Re-verify all errors up to MAX_RETRIES times
  if (!shouldStop && retryQueue.length > 0) {
    for (let retry = 1; retry <= MAX_RETRIES && retryQueue.length > 0 && !shouldStop; retry++) {
      const toRetry = [...retryQueue];
      retryQueue = [];
      updateStatus(`🔄 Retry pass ${retry}/${MAX_RETRIES}: ${toRetry.length} emails...`, "warning");

      for (let i = 0; i < toRetry.length; i += BATCH_SIZE) {
        if (shouldStop) break;
        const batch = toRetry.slice(i, i + BATCH_SIZE);
        await processBatch(batch, true); // isRetry = true
      }
    }
  }

  if (!shouldStop) {
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(1) : "N/A";
    const errorCount = results.filter(r => r.status === "error").length;
    updateStatus(`✅ Complete! ${results.length} emails in ${elapsed}s` + (errorCount > 0 ? ` (${errorCount} unresolved errors)` : ""), "success");
    sendCompleteMessage();
    chrome.storage.local.set({ isProcessing: false });
  } else {
    sendStopMessage();
  }
  cleanupTabs();
  isProcessing = false;
  stopHeartbeat();
}

async function processBatch(batch, isRetry = false) {
  try {
    const tabs = [];

    // Create/reuse tabs
    for (let i = 0; i < batch.length; i++) {
      const email = batch[i];
      const url = `https://mailmeteor.com/email-checker?email=${encodeURIComponent(email)}`;
      let tabId;
      if (reusableTabIds[i]) {
        tabId = reusableTabIds[i];
        try { await chrome.tabs.get(tabId); await chrome.tabs.update(tabId, { url, active: false }); }
        catch (e) { const t = await chrome.tabs.create({ url, active: false }); tabId = t.id; reusableTabIds[i] = tabId; }
      } else {
        const t = await chrome.tabs.create({ url, active: false });
        tabId = t.id;
        reusableTabIds[i] = tabId;
      }
      tabs.push(tabId);
    }

    // Wait for load
    await Promise.race([
      Promise.all(tabs.map(id => waitForTabLoad(id))),
      delay(TAB_LOAD_TIMEOUT),
    ]);
    await delay(1000);

    // Submit forms
    for (let i = 0; i < tabs.length; i++) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tabs[i] }, func: injectEmailAndSubmit, args: [batch[i]] });
      } catch (e) {}
      if (i < tabs.length - 1) await delay(200);
    }

    await delay(1500);

    // Poll results
    const promises = tabs.map(async (tabId, idx) => {
      const email = batch[idx];
      try {
        const maxPolls = isRetry ? RETRY_POLL_ATTEMPTS : MAX_POLL_ATTEMPTS;
        const r = await pollForResults(tabId, email, maxPolls);
        const result = { email, status: r.status, format: r.format||"-", professional: r.professional||"-", domain: r.domain||"-", mailbox: r.mailbox||"-" };

        // Find existing result index or push new
        if (isRetry) {
          const existIdx = results.findIndex(x => x.email === email);
          if (existIdx >= 0) { results[existIdx] = result; }
          else { results.push(result); }
        } else {
          results.push(result);
        }

        // Track errors for retry
        if (result.status === "error") {
          retryQueue.push(email);
        }

        saveResults();
        const statusType = result.status === "valid" ? "success" : result.status === "invalid" ? "error" : result.status === "unknown" ? "info" : result.status === "risky" ? "warning" : "error";
        updateStatus(`${email}: ${result.status}`, statusType);
        return result;
      } catch (error) {
        const result = { email, status: "error", format: "-", professional: "-", domain: "-", mailbox: "-" };
        if (isRetry) {
          const existIdx = results.findIndex(x => x.email === email);
          if (existIdx >= 0) results[existIdx] = result;
          else results.push(result);
        } else {
          results.push(result);
        }
        retryQueue.push(email);
        saveResults();
        return result;
      }
    });

    await Promise.all(promises);
    if (!isRetry) {
      processedCount += batch.length;
      totalProcessed = processedCount;
    }
    saveState();
    updateProgress(processedCount, currentEmails.length);

    if (startTime) {
      const spd = (totalProcessed / ((Date.now() - startTime) / 1000)).toFixed(1);
      updateStatus(`⚡ ${spd} emails/sec | Retry queue: ${retryQueue.length}`, "info");
    }
  } catch (error) {
    console.error("Batch error:", error);
    saveState();
  }
}

// ============================================================
// INJECT EMAIL + SUBMIT
// ============================================================
function injectEmailAndSubmit(email) {
  try {
    const input = document.querySelector("#email-to-check");
    if (!input) return { submitted: false };

    const vue = document.querySelector("#email-checker")?.__vue__;
    if (vue) {
      if (vue.$data) {
        for (const k of Object.keys(vue.$data)) {
          if (k.toLowerCase().includes("email") && typeof vue.$data[k] === 'string') vue.$data[k] = email;
        }
      }
      if (typeof vue.email !== 'undefined') vue.email = email;
      if (typeof vue.emailToCheck !== 'undefined') vue.emailToCheck = email;
      const methods = ['checkEmail','submitForm','verify','handleSubmit','onSubmit'];
      for (const m of methods) { if (typeof vue[m] === 'function') { input.value = email; vue[m](); return { submitted: true, method: `vue.${m}` }; } }
      input.value = email;
      vue.$forceUpdate();
    }

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, email);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => {
      document.querySelector('#email-checker form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      document.querySelector('button[type="submit"]')?.click();
    }, 100);
    return { submitted: true };
  } catch (e) { return { submitted: false }; }
}

// ============================================================
// POLL FOR RESULTS
// ============================================================
async function pollForResults(tabId, email, maxAttempts = MAX_POLL_ATTEMPTS) {
  let attempts = 0;
  let retriedSubmit = false;
  let retriedReload = false;

  while (attempts < maxAttempts && !shouldStop) {
    try {
      const inj = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeResults });
      const r = inj[0].result;

      if (r.captcha) { await delay(1500); attempts++; continue; }
      if (r.found) return r;

      if (!retriedSubmit && attempts >= 8) {
        retriedSubmit = true;
        await chrome.scripting.executeScript({ target: { tabId }, func: injectEmailAndSubmit, args: [email] });
        await delay(3500);
        attempts++;
        continue;
      }

      if (!retriedReload && attempts >= 22) {
        retriedReload = true;
        await chrome.tabs.update(tabId, { url: `https://mailmeteor.com/email-checker?email=${encodeURIComponent(email)}` });
        await waitForTabLoad(tabId);
        await delay(2500);
        await chrome.scripting.executeScript({ target: { tabId }, func: injectEmailAndSubmit, args: [email] });
        await delay(4000);
        attempts++;
        continue;
      }

      await delay(CHECK_INTERVAL);
      attempts++;
    } catch (e) { await delay(CHECK_INTERVAL); attempts++; }
  }
  return { status: "error", format: "-", professional: "-", domain: "-", mailbox: "-" };
}

// ============================================================
// SCRAPE RESULTS - includes "unknown" status
// ============================================================
function scrapeResults() {
  try {
    const body = document.body;
    if (!body) return { found: false, loading: true };
    const text = body.innerText || "";

    if (text.includes("Verify you are human") || text.includes("Just a moment") ||
      document.querySelector(".cf-challenge-running")) {
      return { found: false, captcha: true };
    }

    // Check for "Something went wrong" error
    if (text.includes("Something went wrong") || text.includes("Unable to verify")) {
      return { found: true, status: "error", format: "-", professional: "-", domain: "-", mailbox: "-" };
    }

    const resultHeader = document.querySelector(".result-header");
    if (!resultHeader) return { found: false, loading: true };

    const container = resultHeader.closest(".result-container");
    if (container && window.getComputedStyle(container).display === "none") return { found: false, loading: true };

    const h3 = resultHeader.querySelector("h3");
    if (!h3) return { found: false, loading: true };

    const ms = h3.textContent.trim().toLowerCase();
    if (ms.includes("search") || ms.includes("check") || ms.includes("verif") || ms.includes("loading") || ms === "") {
      return { found: false, loading: true };
    }

    const items = document.querySelectorAll(".result-details-item");
    let format="-", professional="-", domain="-", mailbox="-";

    items.forEach(item => {
      const flex = item.querySelector(".d-flex");
      if (!flex) return;
      const spans = flex.querySelectorAll("span");
      if (spans.length < 2) return;
      const lbl = spans[0].textContent.trim().toLowerCase();
      const badge = item.querySelector(".badge");
      const val = badge ? badge.textContent.trim().toLowerCase() : "-";
      if (lbl.includes("format")) format = val;
      else if (lbl.includes("professional")) professional = val;
      else if (lbl.includes("domain")) domain = val;
      else if (lbl.includes("mailbox")) mailbox = val;
    });

    if (items.length === 0) return { found: false, loading: true };

    // ★ STATUS MAPPING - includes unknown
    let status = "error";
    if (ms === "valid") status = "valid";
    else if (ms === "invalid" || ms.includes("not deliverable") || ms.includes("not valid")) status = "invalid";
    else if (ms === "unknown" || ms.includes("unknown")) status = "unknown";
    else if (ms.includes("risky") || ms.includes("accept") || ms.includes("catch")) status = "risky";

    return { found: true, status, format, professional, domain, mailbox };
  } catch (e) { return { found: false, loading: true }; }
}

// ============================================================
// TAB MANAGEMENT
// ============================================================
async function cleanupTabs() {
  for (const id of reusableTabIds) { try { await chrome.tabs.remove(id); } catch(e) {} }
  reusableTabIds = [];
}

async function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const to = setTimeout(resolve, TAB_LOAD_TIMEOUT);
    chrome.tabs.onUpdated.addListener(function fn(id, info) {
      if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(to); resolve(); }
    });
  });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// MESSAGING
// ============================================================
function updateStatus(text, type) {
  try { chrome.runtime.sendMessage({ type: "status", text, status: type }).catch(()=>{}); } catch(e) {}
}

function updateProgress(current, total) {
  try {
    const stats = { valid:0, invalid:0, risky:0, unknown:0, error:0 };
    for (const r of results) {
      if (r.status==="valid") stats.valid++;
      else if (r.status==="invalid") stats.invalid++;
      else if (r.status==="risky") stats.risky++;
      else if (r.status==="unknown") stats.unknown++;
      else stats.error++;
    }
    let speed = "0";
    if (startTime && totalProcessed > 0) speed = (totalProcessed / ((Date.now()-startTime)/1000)).toFixed(1);
    chrome.runtime.sendMessage({ type:"progress", current, total, stats, speed, latestResults: results.slice(-15), retryQueueSize: retryQueue.length }).catch(()=>{});
  } catch(e) {}
}

// ============================================================
// RESULTS TAB
// ============================================================
function showResultsInTab(data) {
  let rows = "";
  data.forEach(r => {
    const bc = r.status==="valid"?"#4CAF50":r.status==="invalid"?"#ef5350":r.status==="risky"?"#ff9800":r.status==="unknown"?"#42A5F5":"#bdbdbd";
    rows += `<tr><td>${r.email}</td><td style="color:${bc};font-weight:700">${r.status}</td><td>${r.format}</td><td>${r.professional}</td><td>${r.domain}</td><td>${r.mailbox}</td></tr>`;
  });
  const s = {v:0,i:0,r:0,u:0,e:0};
  data.forEach(r=>{if(r.status==="valid")s.v++;else if(r.status==="invalid")s.i++;else if(r.status==="risky")s.r++;else if(r.status==="unknown")s.u++;else s.e++;});

  const html = `<html><head><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',system-ui,sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;padding:30px;color:#e0e0e0}.c{max-width:1300px;margin:0 auto;background:rgba(255,255,255,.06);backdrop-filter:blur(20px);padding:30px;border-radius:16px;border:1px solid rgba(255,255,255,.1);box-shadow:0 8px 32px rgba(0,0,0,.3)}h2{color:#fff;margin-bottom:20px;font-size:24px}table{border-collapse:collapse;width:100%;margin-top:20px;font-size:13px}th{background:rgba(33,150,243,.3);color:#90caf9;padding:10px 14px;text-align:left;font-weight:600;border-bottom:2px solid rgba(33,150,243,.4)}td{padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.06)}tr:hover td{background:rgba(255,255,255,.04)}button{padding:10px 22px;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;margin-right:10px;transition:all .2s}.g{background:linear-gradient(135deg,#4CAF50,#66BB6A)}.b{background:linear-gradient(135deg,#2196F3,#42A5F5)}.r{background:linear-gradient(135deg,#ef5350,#e53935)}button:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}.sum{display:flex;gap:14px;margin:20px 0}.si{flex:1;text-align:center;padding:16px;background:rgba(255,255,255,.05);border-radius:10px;border:1px solid rgba(255,255,255,.08)}.si h3{color:#90a4ae;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}.si .n{font-size:28px;font-weight:800}</style></head><body><div class="c"><h2>⚡ EndBounce Email Checker Results</h2><div class="sum"><div class="si"><h3>Total</h3><div class="n" style="color:#fff">${data.length}</div></div><div class="si"><h3>Valid</h3><div class="n" style="color:#66BB6A">${s.v}</div></div><div class="si"><h3>Invalid</h3><div class="n" style="color:#ef5350">${s.i}</div></div><div class="si"><h3>Risky</h3><div class="n" style="color:#FFA726">${s.r}</div></div><div class="si"><h3>Unknown</h3><div class="n" style="color:#42A5F5">${s.u}</div></div><div class="si"><h3>Errors</h3><div class="n" style="color:#bdbdbd">${s.e}</div></div></div><div style="margin:20px 0"><button class="g" onclick="copyT()">📋 Copy</button><button class="b" onclick="dlCSV()">📥 CSV</button><button class="r" onclick="window.close()">✖ Close</button></div><table id="t"><tr><th>Email</th><th>Status</th><th>Format</th><th>Professional</th><th>Domain</th><th>Mailbox</th></tr>${rows}</table></div><script>function copyT(){let t="Email\\tStatus\\tFormat\\tProfessional\\tDomain\\tMailbox\\n";document.querySelectorAll("#t tr:not(:first-child)").forEach(r=>{const c=r.querySelectorAll("td");t+=Array.from(c).map(x=>x.textContent).join("\\t")+"\\n"});navigator.clipboard.writeText(t).then(()=>alert("Copied!"))}function dlCSV(){let c="Email,Status,Format,Professional,Domain,Mailbox\\n";document.querySelectorAll("#t tr:not(:first-child)").forEach(r=>{const d=r.querySelectorAll("td");c+=Array.from(d).map(x=>'"'+x.textContent+'"').join(",")+"\\n"});const b=new Blob([c],{type:'text/csv'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='endbounce_results.csv';a.click()}<\/script></body></html>`;

  chrome.tabs.create({ url: "data:text/html;charset=utf-8," + encodeURIComponent(html), active: true });
}

function sendCompleteMessage() {
  chrome.storage.local.set({ results, processedCount, isProcessing: false });
  try { chrome.runtime.sendMessage({ type:"processingComplete", results }).catch(()=>{}); } catch(e) {}
  showResultsInTab(results);
}
function sendStopMessage() {
  chrome.storage.local.set({ results, processedCount, isProcessing: false });
  try { chrome.runtime.sendMessage({ type:"processingStopped", results }).catch(()=>{}); } catch(e) {}
  if (results.length > 0) showResultsInTab(results);
}

console.log("✅ EndBounce Checker v5 loaded");
