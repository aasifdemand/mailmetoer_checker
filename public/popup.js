document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);
  const emailsTA=$("emails"), startBtn=$("startBtn"), stopBtn=$("stopBtn"), copyBtn=$("copyBtn"),
    clearBtn=$("clearBtn"), statusDiv=$("status"), progressFill=$("progress"), progressText=$("progressText"),
    validSpan=$("validCount"), invalidSpan=$("invalidCount"), riskySpan=$("riskyCount"),
    unknownSpan=$("unknownCount"), errorSpan=$("errorCount"), speedRate=$("speedRate"),
    processedSpan=$("processedCount"), previewTable=$("previewTable"),
    uploadArea=$("uploadArea"), excelFile=$("excelFile"), fileNameEl=$("fileName"),
    downloadBtn=$("downloadBtn"), downloadOptions=$("downloadOptions"),
    tabCountSelect=$("tabCount"), speedWarning=$("speedWarning"), retryInfo=$("retryInfo"),
    startRowIn=$("startRow"), endRowIn=$("endRow"), 
    columnSelector=$("columnSelector"), emailColumn=$("emailColumn"),
    existingFilesContainer=$("existingFilesContainer"), existingFiles=$("existingFiles");

  const socket = io();

  let isProcessing = false;
  let currentResults = [];
  let fileOptions = null; // Stores filename, originalName, and selected column

  // Restore
  restoreFromStorage();
  loadExistingFiles();

  async function loadExistingFiles() {
    try {
      const res = await fetch('/list-files');
      const files = await res.json();
      if (files.length > 0) {
        existingFilesContainer.style.display = "block";
        existingFiles.innerHTML = '<option value="">-- Select a recently uploaded file --</option>';
        files.sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).forEach(f => {
          const opt = document.createElement("option");
          opt.value = f.filename;
          opt.textContent = `${f.originalName} (${new Date(f.uploadedAt).toLocaleString()})`;
          existingFiles.appendChild(opt);
        });
      }
    } catch (e) {
      console.error("Error loading existing files", e);
    }
  }

  existingFiles.addEventListener("change", async () => {
    const filename = existingFiles.value;
    if (!filename) return;

    fileNameEl.textContent = `⏳ Scanning ${filename}...`;
    try {
      const res = await fetch(`/scan-file/${filename}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      handleFileReady(data);
    } catch (err) {
      fileNameEl.textContent = `❌ ${err.message}`;
      log(`❌ Scan failed: ${err.message}`, "error");
    }
  });

  function handleFileReady(data) {
    fileOptions = {
      filename: data.filename,
      originalName: data.originalName,
      headers: data.headers
    };

    fileNameEl.textContent = `✅ ${data.originalName} (Ready)`;
    
    // Setup column selector
    columnSelector.style.display = "flex";
    emailColumn.innerHTML = "";
    data.headers.forEach(h => {
      const opt = document.createElement("option");
      opt.value = h;
      opt.textContent = h;
      if (h.toLowerCase().includes("email")) opt.selected = true;
      emailColumn.appendChild(opt);
    });

    emailsTA.style.display = "none";
    log(`📝 File ready. Please select the email column and click Start.`, "success");
  }

  function restoreFromStorage() {
    try {
      const results = JSON.parse(localStorage.getItem("results") || "[]");
      const currentEmails = JSON.parse(localStorage.getItem("currentEmails") || "[]");
      const processedCount = parseInt(localStorage.getItem("processedCount") || "0");
      
      applyState({ 
        isProcessing: false, 
        emails: currentEmails, 
        results: results, 
        processedCount: processedCount 
      });
      
      if (results.length) log(`📦 Restored ${results.length} results from local storage`, "success");
    } catch(e) {
      console.error("Restore error", e);
    }
  }

  function applyState(s) {
    if (s.isProcessing) { 
      isProcessing=true; 
      startBtn.disabled=true; 
      stopBtn.disabled=false; 
      tabCountSelect.disabled=true; 
    }
    if (s.emails?.length) { 
      emailsTA.value = s.emails.join("\n"); 
    }
    if (s.results?.length) { 
      currentResults = s.results;
      updatePreview(s.results.slice(-15)); 
      updateStats(s.results); 
      copyBtn.disabled=false; 
    }
    if (s.processedCount !== undefined && s.emails) updateProgress(s.processedCount, s.emails.length);
  }

  // Upload (Streaming Flow)
  uploadArea.addEventListener("click", () => excelFile.click());
  excelFile.addEventListener("change", async e => {
    const file = e.target.files[0]; if (!file) return;
    fileNameEl.textContent = `⏳ Uploading ${file.name}...`;
    
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/upload', { method: 'POST', body: formData });
      const data = await res.json();
      
      if (data.error) throw new Error(data.error);

      handleFileReady(data);


    } catch(err) {
      fileNameEl.textContent = `❌ ${err.message}`;
      log(`❌ Upload failed: ${err.message}`, "error");
    }
  });

  // Start
  startBtn.addEventListener("click", () => {
    let emails = [];
    if (!fileOptions) {
      emails = emailsTA.value.split("\n").map(e=>e.trim()).filter(e=>e.includes("@"));
      if (!emails.length) { log("No emails or file","error" ); return; }
    }

    isProcessing=true; startBtn.disabled=true; stopBtn.disabled=false; clearBtn.disabled=true; tabCountSelect.disabled=true;
    resetTable();
    const tabs = parseInt(tabCountSelect.value);
    const interval = tabs >= 40 ? 100 : tabs >= 20 ? 150 : tabs >= 10 ? 250 : tabs >= 5 ? 350 : 500;
    
    const options = {
      emails: fileOptions ? null : [...new Set(emails)],
      batchSize: tabs,
      checkInterval: interval,
      fileOptions: fileOptions ? {
        filename: fileOptions.filename,
        originalName: fileOptions.originalName,
        columnName: emailColumn.value,
        startRow: parseInt(startRowIn.value) || 1,
        endRow: parseInt(endRowIn.value) || null
      } : null
    };

    if (!fileOptions) {
      localStorage.setItem("currentEmails", JSON.stringify(options.emails));
      localStorage.setItem("results", "[]");
      localStorage.setItem("processedCount", "0");
    }
    
    currentResults = [];
    log(`🚀 Starting processing...`, "info");
    socket.emit("startProcessing", options);
  });

  // Stop
  stopBtn.addEventListener("click", () => {
    socket.emit("stopProcessing");
    isProcessing=false; startBtn.disabled=false; stopBtn.disabled=true; clearBtn.disabled=false; tabCountSelect.disabled=false;
    log("⏹ Stopping...","warning");
  });

  // Clear
  clearBtn.addEventListener("click", () => {
    emailsTA.value=""; emailsTA.style.display="block";
    fileNameEl.textContent=""; excelFile.value="";
    fileOptions = null;
    columnSelector.style.display = "none";
    localStorage.removeItem("currentEmails");
    localStorage.removeItem("results");
    localStorage.removeItem("processedCount");
    currentResults = [];
    resetTable(); updateStats([]); updateProgress(0,0); retryInfo.style.display="none";
    log("🗑 Cleared","info");
  });

  // Other UI logic (Copy, Download, etc.) remains identical
  copyBtn.addEventListener("click", () => {
    if (!currentResults?.length) return;
    let t="Email\tStatus\tFormat\tProfessional\tDomain\tMailbox\n";
    currentResults.forEach(r => t+=`${r.email}\t${r.status}\t${r.format}\t${r.professional}\t${r.domain}\t${r.mailbox}\n`);
    navigator.clipboard.writeText(t).then(()=>log("📋 Copied!","success"));
  });

  downloadBtn.addEventListener("click", () => { downloadOptions.style.display = downloadOptions.style.display==="flex"?"none":"flex"; });
  $("downloadCsvBtn").addEventListener("click", () => dl("csv"));
  $("downloadExcelBtn").addEventListener("click", () => dl("xlsx"));
  $("downloadTxtBtn").addEventListener("click", () => dl("txt"));

  function dl(fmt) {
    if (!currentResults?.length) return;
    const r = currentResults;
    if (fmt==="csv") {
      let csv="Email,Status,Format,Professional,Domain,Mailbox\n";
      r.forEach(x=>csv+=`"${x.email}","${x.status}","${x.format}","${x.professional}","${x.domain}","${x.mailbox}"\n`);
      dlBlob(csv,"text/csv",`results.csv`);
    } else if (fmt==="xlsx") {
      const data=[["Email","Status","Format","Professional","Domain","Mailbox"]];
      r.forEach(x=>data.push([x.email,x.status,x.format,x.professional,x.domain,x.mailbox]));
      const wb=XLSX.utils.book_new(), ws=XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(wb,ws,"Results");
      XLSX.writeFile(wb,`results.xlsx`);
    } else {
      let t="ENDBOUNCE RESULTS\n";
      r.forEach(x=>t+=`${x.email} → ${x.status}\n`);
      dlBlob(t,"text/plain",`results.txt`);
    }
  }
  function dlBlob(c,t,n) { const b=new Blob([c],{type:t}),u=URL.createObjectURL(b),a=document.createElement("a"); a.href=u; a.download=n; a.click(); URL.revokeObjectURL(u); }

  // Socket Events
  socket.on("status", msg => log(msg.text, msg.status));
  socket.on("progress", msg => {
    updateProgress(msg.current, msg.total);
    validSpan.textContent=msg.stats.valid; 
    invalidSpan.textContent=msg.stats.invalid;
    riskySpan.textContent=msg.stats.risky; 
    unknownSpan.textContent=msg.stats.unknown;
    errorSpan.textContent=msg.stats.error; 
    processedSpan.textContent=msg.current;
    if (msg.speed) speedRate.textContent=msg.speed+"/s";
    if (msg.latestResults) updatePreview(msg.latestResults);
  });
  socket.on("processingComplete", msg => {
    isProcessing=false; startBtn.disabled=false; stopBtn.disabled=true; clearBtn.disabled=false; tabCountSelect.disabled=false;
    log("✅ Complete!", "success");
  });

  // Helpers
  function log(text, type="info") {
    const colors={success:"#3fb950",error:"#f85149",warning:"#d29922",info:"#58a6ff"};
    const d=document.createElement("div"); d.style.color=colors[type];
    d.textContent=`[${new Date().toLocaleTimeString()}] ${text}`;
    statusDiv.appendChild(d); statusDiv.scrollTop=statusDiv.scrollHeight;
  }
  function updateProgress(cur, total) {
    const pct = total ? (cur/total)*100 : 0;
    progressFill.style.width=`${pct}%`;
    progressText.textContent=`${cur} / ${total || '?'} (${pct.toFixed(1)}%)`;
  }
  function resetTable() { previewTable.innerHTML='<tr><th>Email</th><th>Status</th><th>Format</th><th>Domain</th><th>Mailbox</th></tr>'; }
  function updatePreview(items) {
    if (!items?.length) return;
    let h='<tr><th>Email</th><th>Status</th><th>Format</th><th>Domain</th><th>Mailbox</th></tr>';
    items.forEach(r => {
      const bc = r.status==="valid"?"b-valid":r.status==="invalid"?"b-invalid":r.status==="risky"?"b-risky":r.status==="unknown"?"b-unknown":"b-error";
      h+=`<tr><td>${r.email}</td><td><span class="badge ${bc}">${r.status}</span></td><td>${r.format}</td><td>${r.domain}</td><td>${r.mailbox}</td></tr>`;
    });
    previewTable.innerHTML=h;
  }
  function updateStats(results) { /* ... simplified ... */ }
});
