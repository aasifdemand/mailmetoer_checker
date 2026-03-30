const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { connect } = require('puppeteer-real-browser');
const proxies = require('./proxies');
const PQueue = require('p-queue').default;
require('dotenv').config();

// Global error handlers to prevent crashes from library cleanup errors (EPERM, etc.)
process.on('uncaughtException', (err) => {
    if (err.code === 'EPERM') return; // Silence Windows permission errors during background cleanup
    console.warn('⚠️ Global Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    if (reason?.code === 'EPERM') return;
    console.warn('⚠️ Global Unhandled Rejection:', reason?.message || reason);
});
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const ExcelJS = require('exceljs');
const csv = require('csv-parser');

const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const METADATA_FILE = path.join('uploads', 'metadata.json');

function getMetadata() {
    if (!fs.existsSync(METADATA_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(METADATA_FILE));
    } catch (e) {
        return {};
    }
}

function saveMetadata(data) {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'popup.html'));
});

// Scan headers from uploaded file
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const metadata = getMetadata();
    metadata[req.file.filename] = {
        originalName: req.file.originalname,
        uploadedAt: new Date().toISOString()
    };
    saveMetadata(metadata);

    const filePath = req.file.path;
    const headers = await getFileHeaders(filePath, req.file.originalname);
    res.json({ filename: req.file.filename, originalName: req.file.originalname, headers });
});

app.get('/list-files', (req, res) => {
    const metadata = getMetadata();
    const files = Object.entries(metadata).map(([filename, data]) => ({
        filename,
        originalName: data.originalName,
        uploadedAt: data.uploadedAt
    }));
    res.json(files);
});

app.get('/scan-file/:filename', async (req, res) => {
    const { filename } = req.params;
    const metadata = getMetadata();
    const fileData = metadata[filename];

    if (!fileData) return res.status(404).json({ error: 'File not found in metadata' });

    const filePath = path.join('uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });

    try {
        const headers = await getFileHeaders(filePath, fileData.originalName);
        res.json({ filename, originalName: fileData.originalName, headers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function getFileHeaders(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase();
    if (ext === '.csv') {
        return new Promise((resolve, reject) => {
            const results = [];
            fs.createReadStream(filePath)
                .pipe(csv())
                .on('headers', (h) => resolve(h))
                .on('error', (err) => reject(err));
        });
    } else if (ext === '.xlsx' || ext === '.xls') {
        const stream = fs.createReadStream(filePath);
        const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(stream);
        for await (const worksheetReader of workbookReader) {
            for await (const row of worksheetReader) {
                return row.values.filter(v => v !== undefined).map(v => String(v));
            }
        }
        return []; // No headers found if no rows
    } else {
        // Default for text files or unknown types
        return ['Text Content'];
    }
}

// State variables
let isProcessing = false;
let shouldStop = false;
let results = [];
let currentEmails = [];
let processedCount = 0;
let retryQueue = [];
let startTime = null;

const MAX_POLL_ATTEMPTS = 150; // Increased to 45+ seconds for slow verifications


/**
 * HiveWorker: Manages a single persistent browser instance.
 */
class HiveWorker {
    constructor(id) {
        this.id = id;
        this.browser = null;
        this.profilePath = path.join(__dirname, 'uploads', 'profiles', `w${id}`);
        if (!fs.existsSync(this.profilePath)) {
            fs.mkdirSync(this.profilePath, { recursive: true });
        }
        this.proxy = null;
        this.activeTabs = 0;
    }

    async init() {
        if (this.browser) return;
        this.proxy = proxies.getNext();

        console.log(`[HiveWorker ${this.id}] Initializing with proxy: ${this.proxy ? this.proxy.host : 'DIRECT'}`);

        const config = {
            headless: "auto",
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            customConfig: {
                userDataDir: this.profilePath
            },
            skipTarget: true,
            fingerprint: true,
            turnstile: true,
            connect: { defaultViewport: null }
        };

        if (this.proxy) {
            config.proxy = {
                host: this.proxy.host,
                port: this.proxy.port,
                username: this.proxy.username,
                password: this.proxy.password
            };
        }

        try {
            const result = await connect(config);
            this.browser = result.browser;
            this.browser.on('disconnected', () => { this.browser = null; });
        } catch (err) {
            console.error(`[HiveWorker ${this.id}] Launch failed:`, err.message);
        }
    }

    async close() {
        if (this.browser) {
            try { await this.browser.close(); } catch (e) { }
            this.browser = null;
        }
    }
}

/**
 * WorkerHive: Orchestrates multiple workers and dispatches tasks.
 */
class WorkerHive {
    constructor(numWorkers, tabsPerWorker) {
        this.workers = [];
        this.numWorkers = numWorkers;
        this.tabsPerWorker = tabsPerWorker;
        this.queue = new PQueue({ concurrency: numWorkers * tabsPerWorker });
        this.isReady = false;
    }

    async start() {
        for (let i = 1; i <= this.numWorkers; i++) {
            const worker = new HiveWorker(i);
            await worker.init();
            this.workers.push(worker);
            // Absolute safety for Windows startup
            await delay(6000);
        }
        this.isReady = true;
    }

    async stop() {
        for (const worker of this.workers) await worker.close();
        this.workers = [];
        this.isReady = false;
    }

    getAvailableWorker() {
        // Find worker with fewest active tabs
        return this.workers.sort((a, b) => a.activeTabs - b.activeTabs)[0];
    }
}

const hive = new WorkerHive(2, 10); // 2 Browsers x 10 Tabs = 20 Parallel slots

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startProcessing(emails, batchSize, checkInterval, socket, fileOptions = null) {
    if (isProcessing) return;
    isProcessing = true;
    shouldStop = false;
    currentEmails = emails || [];
    results = [];
    processedCount = 0;
    retryQueue = [];
    startTime = Date.now();

    // 1. Fetch fresh proxies and start Hive
    await proxies.refreshProxies();
    if (proxies.proxies.length === 0) {
        updateStatus("⚠️ No proxies found. Performance will be limited.", "warning", socket);
    }

    updateStatus(`🚀 Warming up the Hive (2 browsers)...`, "info", socket);
    await hive.start();

    if (fileOptions) {
        updateStatus(`🚀 Hive Active: Verifying file with 20 parallel tabs...`, "info", socket);
        await processFileStream(fileOptions, 20, checkInterval, socket);
    } else {
        updateStatus(`🚀 Hive Active: Verifying ${emails.length} emails with 20 parallel tabs...`, "info", socket);
        await processHiveParallel(emails, checkInterval, socket);
    }

    // Resilience Pass
    if (!shouldStop && retryQueue.length > 0) {
        const uniqueRetry = [...new Set(retryQueue)];
        updateStatus(`🔄 Hive Refresh: Retrying ${uniqueRetry.length} failed emails...`, "warning", socket);
        retryQueue = [];
        await delay(15000);
        await processHiveParallel(uniqueRetry, checkInterval, socket, true);
    }

    // Shutdown hive when done (optional, but good for resources)
    await hive.stop();

    if (!shouldStop) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        updateStatus(`✅ Complete! ${results.length} emails in ${elapsed}s`, "success", socket);
        socket.emit('processingComplete', { results });
    } else {
        updateStatus("⏹ Stopped", "warning", socket);
        socket.emit('processingStopped', { results });
    }

    isProcessing = false;
}

async function processFileStream(options, concurrency, checkInterval, socket) {
    const { filename, columnName, startRow, endRow } = options;
    const filePath = path.join('uploads', filename);
    const ext = path.extname(options.originalName).toLowerCase();

    let rowCount = 0;
    const batch = [];

    try {
        if (ext === '.csv') {
            const parser = fs.createReadStream(filePath).pipe(csv());
            for await (const data of parser) {
                if (shouldStop) break;
                rowCount++;
                if (rowCount < (startRow || 1)) continue;
                if (endRow && rowCount > endRow) break;
                let email = data[columnName];
                if (email && email.includes('@')) {
                    email = String(email).replace(/^['"\s]+|['"\s]+$/g, '').trim();
                    batch.push(email);
                }
                if (batch.length >= 1000) { await processHiveParallel(batch, checkInterval, socket); batch.length = 0; }
            }
            if (batch.length > 0) await processHiveParallel(batch, checkInterval, socket);
        } else if (ext === '.xlsx' || ext === '.xls') {
            const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(fs.createReadStream(filePath));
            for await (const worksheetReader of workbookReader) {
                let colIndex = -1;
                for await (const row of worksheetReader) {
                    if (shouldStop) break;
                    rowCount++;
                    if (rowCount === 1) {
                        const vals = Array.from(row.values || []).map(v => v ? String(v).trim().toLowerCase() : "");
                        console.log(`Scanning headers: ${JSON.stringify(vals)}`);
                        colIndex = vals.findIndex(v => v && (v === columnName.toLowerCase() || v.includes("email") || v.includes("mail")));
                        if (colIndex === -1) colIndex = 1; // Fallback to first column
                        continue;
                    }
                    if (rowCount < (startRow || 1)) continue;
                    if (endRow && rowCount > endRow) break;
                    const cell = row.getCell(colIndex);
                    let email = cell ? String(cell.value || "").trim() : "";
                    if (email && email.includes('@')) {
                        email = String(email).replace(/^['"\s]+|['"\s]+$/g, '').trim();
                        batch.push(email);
                    }
                    if (batch.length >= 500) { await processHiveParallel(batch, checkInterval, socket); batch.length = 0; }
                }
            }
            if (batch.length > 0) await processHiveParallel(batch, checkInterval, socket);
        }
    } catch (err) {
        updateStatus(`❌ Hive Stream Error: ${err.message}`, "error", socket);
    }
}

async function processHiveParallel(emails, checkInterval, socket, isRetry = false) {
    const tasks = emails.map((email) => hive.queue.add(async () => {
        if (shouldStop) return;

        const worker = hive.getAvailableWorker();
        if (!worker || !worker.browser) {
            // Self-repair worker if it died
            if (worker) await worker.init();
            if (!worker || !worker.browser) {
                retryQueue.push(email);
                return;
            }
        }

        worker.activeTabs++;
        let page = null;
        try {
            console.log(`[Hive] Worker ${worker.id} processing ${email}`);
            page = await worker.browser.newPage();

            // Stagger inside worker to avoid identical timing
            await delay(Math.random() * 3000);

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
            await page.goto('https://mailmeteor.com/email-checker', { waitUntil: 'domcontentloaded', timeout: 45000 });

            await page.waitForSelector('#email-to-check', { visible: true, timeout: 25000 });
            await page.type('#email-to-check', email, { delay: Math.random() * 50 + 20 });
            await page.click('button.btn-tertiary');

            const result = await pollForResults(page, email, MAX_POLL_ATTEMPTS, checkInterval);

            if (result && result.email) {
                if (isRetry) {
                    const existIdx = results.findIndex(x => x.email === email);
                    if (existIdx >= 0) results[existIdx] = result;
                    else results.push(result);
                } else {
                    results.push(result);
                }
                socket.emit('newResult', result);
            }

            if (result.status === "error" || result.status === "unknown") {
                if (!isRetry) retryQueue.push(email);
            }

            const statusType = result.status === "valid" ? "success" : result.status === "invalid" ? "error" : result.status === "unknown" ? "info" : result.status === "risky" ? "warning" : "error";
            updateStatus(`${email}: ${result.status}`, statusType, socket);

            if (!isRetry) processedCount++;
            updateProgress(processedCount, currentEmails.length, socket);

        } catch (err) {
            console.error(`[Hive Task Error]: ${err.message}`);
            if (!isRetry) retryQueue.push(email);
        } finally {
            worker.activeTabs--;
            if (page) try { await page.close(); } catch (e) { }
        }
    }));

    await Promise.all(tasks);
}

function injectEmailAndSubmit(email) {
    try {
        const input = document.querySelector("#email-to-check");
        if (!input) return;

        // Try Vue instance first
        const vue = document.querySelector("#email-checker")?.__vue__;
        if (vue) {
            if (vue.$data) {
                for (const k of Object.keys(vue.$data)) {
                    if (k.toLowerCase().includes("email") && typeof vue.$data[k] === 'string') vue.$data[k] = email;
                }
            }
            if (typeof vue.email !== 'undefined') vue.email = email;
            if (typeof vue.emailToCheck !== 'undefined') vue.emailToCheck = email;
            const methods = ['checkEmail', 'submitForm', 'verify', 'handleSubmit', 'onSubmit'];
            for (const m of methods) {
                if (typeof vue[m] === 'function') {
                    input.value = email;
                    vue[m]();
                    return;
                }
            }
            input.value = email;
            vue.$forceUpdate();
        }

        // Vanilla fallback
        input.value = email;
        const event = new Event('input', { bubbles: true });
        input.dispatchEvent(event);
        const changeEvent = new Event('change', { bubbles: true });
        input.dispatchEvent(changeEvent);

        setTimeout(() => {
            const form = document.querySelector('#email-checker form');
            if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            const btn = document.querySelector('button[type="submit"]');
            if (btn) btn.click();
        }, 100);
    } catch (e) {
        console.error("Injection error:", e);
    }
}

async function pollForResults(page, email, maxAttempts, checkInterval) {
    let attempts = 0;
    while (attempts < maxAttempts && !shouldStop) {
        try {
            const r = await page.evaluate(scrapeResults);
            if (r.found) {
                console.log(`[Found] ${email}: ${r.status}`);
                return { email, ...r };
            }
            if (r.captcha) {
                console.log(`[Captcha] Waiting for ${email}`);
                await delay(3000);
            } else {
                await delay(checkInterval);
            }
            attempts++;
            if (attempts % 10 === 0) console.log(`[Polling] ${email} - Attempt ${attempts}/${maxAttempts}`);
        } catch (e) {
            await delay(checkInterval);
            attempts++;
        }
    }
    console.log(`[Timeout/Error] ${email} failed after ${attempts} attempts`);
    return { email, status: "error", format: "-", professional: "-", domain: "-", mailbox: "-" };
}

function scrapeResults() {
    try {
        const resultHeader = document.querySelector(".result-header");
        if (!resultHeader) return { found: false };

        const h3 = resultHeader.querySelector("h3");
        if (!h3) return { found: false };

        const statusText = h3.textContent.trim().toLowerCase();

        // Prioritize success/valid status even if other error text exists on page
        let status = null;
        if (statusText === "valid") status = "valid";
        else if (statusText === "invalid" || statusText.includes("not deliverable")) status = "invalid";
        else if (statusText === "unknown") status = "unknown";
        else if (statusText.includes("risky") || statusText.includes("accept") || statusText.includes("catch")) status = "risky";

        // If we found a valid status, extract details
        if (status) {
            const items = document.querySelectorAll(".result-details-item");
            let format = "-", professional = "-", domain = "-", mailbox = "-";
            items.forEach(item => {
                const labelSpan = item.querySelector("span:nth-child(1)");
                const badge = item.querySelector(".badge");
                if (!labelSpan || !badge) return;

                const lbl = labelSpan.textContent.trim().toLowerCase();
                const val = badge.textContent.trim().toLowerCase();

                if (lbl.includes("format")) format = val;
                else if (lbl.includes("professional")) professional = val;
                else if (lbl.includes("domain")) domain = val;
                else if (lbl.includes("mailbox")) mailbox = val;
            });
            return { found: true, status, format, professional, domain, mailbox };
        }

        // Fallback: only if we explicitly see a block/error message and NO status
        const bodyText = document.body.innerText || "";
        if (bodyText.includes("Something went wrong") || bodyText.includes("Unable to verify") || bodyText.includes("Verify you are human")) {
            // Check if it's a captcha block
            if (bodyText.includes("Verify you are human") || bodyText.includes("Just a moment")) {
                return { found: false, captcha: true };
            }
            return { found: true, status: "error", format: "-", professional: "-", domain: "-", mailbox: "-" };
        }

        if (statusText === "" || statusText.includes("loading") || statusText.includes("verifying")) return { found: false };

        return { found: false };
    } catch (e) {
        return { found: false };
    }
}

function updateStatus(text, status, socket) {
    console.log(`[Status] ${text}`);
    socket.emit('status', { text, status });
}

function updateProgress(current, total, socket) {
    const stats = { valid: 0, invalid: 0, risky: 0, unknown: 0, error: 0 };
    results.forEach(r => {
        if (r.status === "valid") stats.valid++;
        else if (r.status === "invalid") stats.invalid++;
        else if (r.status === "risky") stats.risky++;
        else if (r.status === "unknown") stats.unknown++;
        else stats.error++;
    });

    let speed = "0";
    if (startTime && current > 0) {
        speed = (current / ((Date.now() - startTime) / 1000)).toFixed(1);
    }

    console.log(`[Progress] ${current} / ${total || '?'} - Valid: ${stats.valid}, Invalid: ${stats.invalid}, Speed: ${speed}/s`);

    socket.emit('progress', {
        current,
        total,
        stats,
        speed,
        latestResults: results.slice(-15),
        retryQueueSize: retryQueue.length
    });
}

io.on('connection', (socket) => {
    console.log('User connected');

    socket.on('startProcessing', async (data) => {
        console.log('Received startProcessing event', data.fileOptions ? 'for file' : 'for manual list');
        const { emails, batchSize, checkInterval, fileOptions } = data;
        await startProcessing(emails, batchSize || 10, checkInterval || 300, socket, fileOptions);
    });

    socket.on('stopProcessing', () => {
        console.log('Received stopProcessing event');
        shouldStop = true;
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
