/* ============================================================
   SERVER.JS
   Backend lokal (Node.js, tanpa dependency eksternal) untuk
   MediaFire Folder Downloader.

   Kenapa server ini diperlukan (bukan sekadar cita rasa arsitektur):
   Browser menerapkan aturan CORS pada JavaScript yang berjalan di
   dalamnya, sehingga fetch() dari halaman web ke domain lain
   (mediafire.com) sering diblokir jika server tujuan tidak
   mengizinkan origin tsb. Batasan itu HANYA berlaku untuk kode
   yang jalan di dalam browser. Kode Node.js ini berjalan sebagai
   proses terpisah di komputer Anda sendiri (server-to-server),
   sehingga tidak tunduk pada CORS browser — persis seperti cara
   kerja JDownloader atau exe backend lain.

   PRINSIP KEAMANAN/ETIKA YANG TETAP DIPERTAHANKAN:
   - Server ini HANYA mengambil halaman/file yang memang dapat
     diakses publik tanpa login.
   - Tidak ada kode untuk login, bypass CAPTCHA, atau memalsukan
     status Premium. Jika folder/file butuh itu, server akan
     mengembalikan status jelas ke frontend ("restricted"/"premium"),
     bukan mencoba menerobosnya.
   - Server hanya mendengarkan di localhost (127.0.0.1) secara
     default, bukan diekspos ke jaringan luar.
   ============================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3939;
// HOST: "0.0.0.0" wajib dipakai saat di-deploy ke platform hosting (Render,
// Railway, dll) supaya server menerima koneksi dari luar container/mesin.
// Untuk pemakaian lokal di komputer sendiri, "0.0.0.0" tetap aman dan bisa
// diakses lewat "127.0.0.1" atau "localhost" seperti biasa.
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

/* ------------------------------------------------------------
   CATATAN UNTUK MODE ONLINE (mis. di-deploy ke Render):
   Saat aplikasi diakses banyak orang sekaligus, file tidak boleh
   ditaruh dalam satu folder bersama (bisa tabrakan nama & bisa
   dilihat/diunduh siapa saja lewat tebakan nama file). Setiap job
   download karena itu mendapat SUB-FOLDER SENDIRI berbasis jobId,
   dan hanya pemilik job (yang tahu jobId, dari sesi browsernya
   sendiri) yang bisa mengambil filenya lewat endpoint
   GET /api/jobs/:id/files/:fileId.

   File-file lama otomatis dibersihkan secara berkala (lihat
   cleanupOldJobFolders) agar disk server tidak penuh, karena
   hosting gratis biasanya punya kuota disk kecil.
   ------------------------------------------------------------ */
function getJobDownloadDir(jobId) {
  return path.join(DOWNLOADS_DIR, jobId);
}

/* ------------------------------------------------------------
   PASTIKAN FOLDER DOWNLOADS ADA
   ------------------------------------------------------------ */
async function ensureDownloadsDir() {
  await fsp.mkdir(DOWNLOADS_DIR, { recursive: true });
}

/* ------------------------------------------------------------
   STATE ANTRIAN DOWNLOAD (in-memory, per proses server)
   Setiap "job" merepresentasikan satu sesi download (bisa berisi
   banyak file). Progress disimpan di sini dan dipoll oleh
   frontend via GET /api/jobs/:id.
   ------------------------------------------------------------ */
const jobs = new Map(); // jobId -> jobState

function createJob(files, settings) {
  const jobId = crypto.randomUUID();

  const job = {
    id: jobId,
    settings,
    cancelled: false,
    startedAt: Date.now(),
    totalCount: files.length,
    completedCount: 0,
    totalBytesDownloaded: 0,
    files: files.map((f) => ({
      ...f,
      progressPercent: 0,
      status: "waiting", // waiting | downloading | retrying | completed | error | cancelled
      errorMessage: null,
      attempt: 0,
      receivedBytes: 0,
      totalBytes: f.sizeBytes || 0,
      savedPath: null,
    })),
    log: [],
  };

  jobs.set(jobId, job);
  return job;
}

function addJobLog(job, message, level = "info") {
  job.log.push({ time: Date.now(), message, level });
  // Batasi ukuran log per job agar memori tidak membengkak
  if (job.log.length > 500) job.log.shift();
}

/* ------------------------------------------------------------
   UTIL: PARSING UKURAN TEKS "12.5 MB" -> BYTES
   ------------------------------------------------------------ */
function parseSizeText(text) {
  if (!text) return null;
  const match = text.trim().match(/([\d.,]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return null;
  const value = parseFloat(match[1].replace(",", "."));
  const unit = match[2].toUpperCase();
  const multipliers = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(value * (multipliers[unit] || 1));
}

/* ------------------------------------------------------------
   UTIL: DETEKSI TIPE FILE DARI EKSTENSI
   ------------------------------------------------------------ */
function detectFileType(filename) {
  if (!filename) return "unknown";
  const ext = filename.split(".").pop().toLowerCase();
  const map = {
    pdf: "document", doc: "document", docx: "document", txt: "document", rtf: "document", odt: "document",
    xls: "spreadsheet", xlsx: "spreadsheet", csv: "spreadsheet",
    ppt: "presentation", pptx: "presentation",
    jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", svg: "image", bmp: "image",
    mp3: "audio", wav: "audio", flac: "audio", aac: "audio", ogg: "audio", m4a: "audio",
    mp4: "video", mkv: "video", avi: "video", mov: "video", webm: "video", flv: "video",
    zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",
    apk: "app", exe: "app", msi: "app", dmg: "app",
  };
  return map[ext] || "unknown";
}

/* ------------------------------------------------------------
   VALIDASI URL FOLDER MEDIAFIRE
   ------------------------------------------------------------ */
function isValidMediaFireFolderUrl(url) {
  try {
    const parsed = new URL(url);
    const isHost = /(^|\.)mediafire\.com$/i.test(parsed.hostname);
    const isFolderPath = /\/folder\//i.test(parsed.pathname);
    return isHost && isFolderPath;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------
   FETCH HELPER DENGAN TIMEOUT (server-side, tanpa batasan CORS)
   ------------------------------------------------------------ */
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        // User-Agent standar browser agar server MediaFire merespons
        // dengan halaman normal (sama seperti diakses browser biasa).
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        ...(options.headers || {}),
      },
    });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ------------------------------------------------------------
   DETEKSI SINYAL "TIDAK TERSEDIA PUBLIK" DARI TEKS HALAMAN
   ------------------------------------------------------------ */
function detectAvailabilityIssue(bodyTextLower) {
  const notFoundSignals = ["page not found", "folder not found", "this folder key is invalid", "invalid or deleted"];
  const authSignals = ["you must be logged in", "please log in", "sign in to view"];
  const premiumSignals = ["premium account", "upgrade to premium", "requires a premium"];

  if (notFoundSignals.some((s) => bodyTextLower.includes(s))) {
    return { blocked: true, reason: "not_found", message: "Folder/file tidak ditemukan atau sudah dihapus." };
  }
  if (authSignals.some((s) => bodyTextLower.includes(s))) {
    return { blocked: true, reason: "auth", message: "Memerlukan login. Aplikasi tidak akan mencoba melewati autentikasi MediaFire." };
  }
  if (premiumSignals.some((s) => bodyTextLower.includes(s))) {
    return { blocked: true, reason: "premium", message: "Memerlukan akun Premium MediaFire. Aplikasi tidak akan mencoba melewati batasan ini." };
  }
  return { blocked: false, reason: null, message: null };
}

/* ------------------------------------------------------------
   PARSING HTML FOLDER MENJADI DAFTAR FILE
   Menggunakan regex sederhana yang tahan-cukup terhadap variasi
   markup, karena Node.js tidak punya DOMParser bawaan dan kita
   sengaja menghindari dependency eksternal (mis. cheerio/jsdom)
   agar instalasi tetap "zero-install".
   ------------------------------------------------------------ */
function parseFolderHtml(html) {
  const bodyTextLower = html.toLowerCase();
  const availability = detectAvailabilityIssue(bodyTextLower);
  if (availability.blocked) {
    return { success: false, files: [], folderName: null, error: availability.message };
  }

  let folderName = null;
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  if (titleMatch) {
    folderName = titleMatch[1].replace(/\s*[-|]\s*MediaFire.*$/i, "").trim();
  }

  const files = [];
  const seenUrls = new Set();

  // Strategi utama: cari semua link menuju halaman detail file
  // (/file/<key>/<nama>/file). Ini adalah pola URL paling stabil
  // yang dipakai MediaFire pada tampilan folder standar maupun versi baru.
  const fileLinkRegex = /<a[^>]+href="([^"]*mediafire\.com\/file\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = fileLinkRegex.exec(html)) !== null) {
    const rawUrl = match[1].replace(/&amp;/g, "&");
    if (seenUrls.has(rawUrl)) continue;
    seenUrls.add(rawUrl);

    // Bersihkan tag HTML di dalam teks link untuk mendapatkan nama file
    const rawText = match[2].replace(/<[^>]+>/g, "").trim();
    const name = rawText || extractFileNameFromUrl(rawUrl);

    // Coba temukan ukuran file di sekitar posisi link ini (±400 karakter)
    const surroundingStart = Math.max(0, match.index - 200);
    const surroundingEnd = Math.min(html.length, match.index + match[0].length + 400);
    const surroundingText = html.slice(surroundingStart, surroundingEnd);
    const sizeMatch = surroundingText.match(/([\d.,]+\s*(?:B|KB|MB|GB|TB))/i);
    const sizeBytes = sizeMatch ? parseSizeText(sizeMatch[1]) : null;

    // Deteksi tanda "premium"/"restricted" di sekitar link ini
    const surroundingLower = surroundingText.toLowerCase();
    let status = "available";
    if (surroundingLower.includes("premium")) status = "premium";
    else if (surroundingLower.includes("password") || surroundingLower.includes("restricted")) status = "restricted";

    files.push({
      id: crypto.randomUUID(),
      name,
      sizeBytes,
      type: detectFileType(name),
      downloadPageUrl: rawUrl,
      status,
    });
  }

  if (files.length === 0) {
    return {
      success: false,
      files: [],
      folderName,
      error: "Tidak ada file yang terdeteksi. Folder mungkin kosong, memerlukan Premium/login, atau struktur halaman berubah.",
    };
  }

  return { success: true, files, folderName, error: null };
}

function extractFileNameFromUrl(url) {
  try {
    const parts = url.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || "file_tanpa_nama");
  } catch {
    return "file_tanpa_nama";
  }
}

/* ------------------------------------------------------------
   AMBIL DIRECT DOWNLOAD LINK DARI HALAMAN DETAIL FILE
   ------------------------------------------------------------ */
async function resolveDirectDownloadLink(filePageUrl, timeoutMs) {
  let response;
  try {
    response = await fetchWithTimeout(filePageUrl, {}, timeoutMs);
  } catch (err) {
    return { success: false, restricted: false, message: `Gagal menghubungi halaman file: ${err.message}` };
  }

  if (!response.ok) {
    return { success: false, restricted: false, message: `Server merespons status ${response.status}.` };
  }

  const html = await response.text();
  const bodyTextLower = html.toLowerCase();
  const availability = detectAvailabilityIssue(bodyTextLower);

  if (availability.blocked) {
    return { success: false, restricted: true, message: availability.message };
  }

  // Tombol download utama MediaFire biasanya berupa <a id="downloadButton" href="...">
  const btnMatch =
    html.match(/id="downloadButton"[^>]*href="([^"]+)"/i) ||
    html.match(/href="([^"]+)"[^>]*id="downloadButton"/i) ||
    html.match(/class="input"[^>]*href="([^"]+)"/i);

  if (!btnMatch) {
    return { success: false, restricted: true, message: "Tombol download tidak ditemukan (file kemungkinan tidak tersedia publik)." };
  }

  const directUrl = btnMatch[1].replace(/&amp;/g, "&");
  return { success: true, directUrl, restricted: false };
}

/* ------------------------------------------------------------
   DOWNLOAD SATU FILE KE DISK DENGAN PROGRESS STREAMING
   ------------------------------------------------------------ */
async function downloadFileToDisk(job, fileState, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(fileState.directUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Gagal menghubungi server file: ${err.message}`);
  }
  clearTimeout(timer);

  if (!response.ok || !response.body) {
    throw new Error(`Server file merespons status ${response.status}.`);
  }

  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  fileState.totalBytes = contentLength || fileState.sizeBytes || 0;

  const safeName = sanitizeFileName(fileState.name);
  const jobDir = getJobDownloadDir(job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  const savePath = path.join(jobDir, safeName);
  const writeStream = fs.createWriteStream(savePath);

  const reader = response.body.getReader();

  try {
    while (true) {
      if (job.cancelled) {
        await reader.cancel();
        writeStream.close();
        await fsp.unlink(savePath).catch(() => {});
        throw new Error("CANCELLED");
      }

      const { done, value } = await reader.read();
      if (done) break;

      await new Promise((resolve, reject) => {
        writeStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });

      fileState.receivedBytes += value.length;
      job.totalBytesDownloaded += value.length;

      fileState.progressPercent =
        fileState.totalBytes > 0
          ? Math.min(100, Math.round((fileState.receivedBytes / fileState.totalBytes) * 100))
          : 0;
    }

    await new Promise((resolve) => writeStream.end(resolve));
    fileState.savedPath = savePath;
    return true;

  } catch (err) {
    writeStream.close();
    if (err.message !== "CANCELLED") {
      await fsp.unlink(savePath).catch(() => {});
    }
    throw err;
  }
}

/* ------------------------------------------------------------
   BERSIHKAN NAMA FILE AGAR AMAN UNTUK DISIMPAN KE DISK
   Mencegah path traversal (mis. "../../etc/passwd") dan
   karakter ilegal di nama file Windows/Linux.
   ------------------------------------------------------------ */
function sanitizeFileName(name) {
  const base = path.basename(name || "file_tanpa_nama");
  const cleaned = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "file_tanpa_nama";
}

/* ------------------------------------------------------------
   JALANKAN JOB DOWNLOAD (worker pool dengan concurrency terbatas)
   Berjalan secara async di background; frontend polling status
   lewat endpoint GET /api/jobs/:id.
   ------------------------------------------------------------ */
async function runJob(job) {
  const { maxConcurrent, maxRetry, timeoutSeconds } = job.settings;
  const timeoutMs = timeoutSeconds * 1000;

  addJobLog(job, `Memulai download ${job.totalCount} file (maks ${maxConcurrent} bersamaan).`, "info");

  let cursor = 0;

  async function worker() {
    while (true) {
      if (job.cancelled) return;
      const index = cursor++;
      if (index >= job.files.length) return;

      const fileState = job.files[index];
      await processFileWithRetry(job, fileState, maxRetry, timeoutMs);
      job.completedCount++;
    }
  }

  const workerCount = Math.max(1, Math.min(maxConcurrent, job.files.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  if (job.cancelled) {
    addJobLog(job, "Proses download dibatalkan oleh pengguna.", "warning");
  } else {
    const successCount = job.files.filter((f) => f.status === "completed").length;
    addJobLog(job, `Selesai. ${successCount}/${job.totalCount} file berhasil diunduh.`, "success");
  }
}

async function processFileWithRetry(job, fileState, maxRetry, timeoutMs) {
  if (!fileState.downloadPageUrl) {
    fileState.status = "error";
    fileState.errorMessage = "Link halaman file tidak ditemukan saat scan.";
    addJobLog(job, `Dilewati "${fileState.name}": ${fileState.errorMessage}`, "error");
    return;
  }

  for (let attempt = 1; attempt <= maxRetry + 1; attempt++) {
    if (job.cancelled) {
      fileState.status = "cancelled";
      return;
    }

    fileState.attempt = attempt;
    fileState.status = attempt > 1 ? "retrying" : "downloading";

    if (attempt > 1) {
      addJobLog(job, `Mencoba ulang "${fileState.name}" (percobaan ${attempt}/${maxRetry + 1}).`, "warning");
      await new Promise((r) => setTimeout(r, 1200));
    }

    try {
      // Langkah 1: resolve direct link dari halaman detail file
      const linkResult = await resolveDirectDownloadLink(fileState.downloadPageUrl, timeoutMs);

      if (!linkResult.success) {
        if (linkResult.restricted) {
          fileState.status = "error";
          fileState.errorMessage = linkResult.message;
          addJobLog(job, `Dilewati "${fileState.name}": ${linkResult.message}`, "error");
          return; // tidak retry untuk file yang memang dibatasi
        }
        throw new Error(linkResult.message);
      }

      fileState.directUrl = linkResult.directUrl;
      fileState.status = "downloading";

      // Langkah 2: download file ke disk dengan progress streaming
      await downloadFileToDisk(job, fileState, timeoutMs);

      fileState.status = "completed";
      fileState.progressPercent = 100;
      addJobLog(job, `Berhasil mengunduh "${fileState.name}".`, "success");
      return;

    } catch (err) {
      if (err.message === "CANCELLED") {
        fileState.status = "cancelled";
        return;
      }

      if (attempt === maxRetry + 1) {
        fileState.status = "error";
        fileState.errorMessage = err.message;
        addJobLog(job, `Gagal mengunduh "${fileState.name}" setelah ${attempt} percobaan: ${err.message}`, "error");
        return;
      }
    }
  }
}

/* ------------------------------------------------------------
   ============ HTTP SERVER & ROUTING ============
   ------------------------------------------------------------ */
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // Batas ukuran body 5MB (mis. untuk paste HTML manual jika suatu
      // saat dibutuhkan) agar server tidak dibanjiri payload raksasa.
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error("Body request terlalu besar."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/* ---------- ROUTE: POST /api/scan ---------- */
async function handleScan(req, res) {
  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch {
    return sendJson(res, 400, { success: false, error: "Body request tidak valid." });
  }

  const url = (body.url || "").trim();

  if (!isValidMediaFireFolderUrl(url)) {
    return sendJson(res, 400, { success: false, error: "URL folder MediaFire tidak valid." });
  }

  let response;
  try {
    response = await fetchWithTimeout(url, {}, 20000);
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    return sendJson(res, 502, {
      success: false,
      error: isTimeout ? "Waktu tunggu habis saat menghubungi MediaFire." : `Gagal menghubungi MediaFire: ${err.message}`,
    });
  }

  if (!response.ok) {
    return sendJson(res, 502, { success: false, error: `MediaFire merespons dengan status ${response.status}.` });
  }

  const html = await response.text();
  const parsed = parseFolderHtml(html);

  if (!parsed.success) {
    return sendJson(res, 200, { success: false, error: parsed.error });
  }

  return sendJson(res, 200, {
    success: true,
    folderName: parsed.folderName,
    files: parsed.files,
  });
}

/* ---------- ROUTE: POST /api/download ---------- */
async function handleStartDownload(req, res) {
  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch {
    return sendJson(res, 400, { success: false, error: "Body request tidak valid." });
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) {
    return sendJson(res, 400, { success: false, error: "Tidak ada file untuk diunduh." });
  }

  const settings = {
    maxConcurrent: clampNumber(body.settings?.maxConcurrent, 1, 10, 2),
    maxRetry: clampNumber(body.settings?.maxRetry, 0, 10, 3),
    timeoutSeconds: clampNumber(body.settings?.timeoutSeconds, 5, 300, 30),
  };

  await ensureDownloadsDir();

  const job = createJob(files, settings);
  // Jalankan job secara async di background (tidak di-await di sini)
  // supaya request POST langsung merespons dengan jobId, dan frontend
  // bisa langsung mulai polling progress.
  runJob(job).catch((err) => {
    addJobLog(job, `Kesalahan tak terduga pada job: ${err.message}`, "error");
  });

  return sendJson(res, 200, { success: true, jobId: job.id });
}

function clampNumber(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ---------- ROUTE: GET /api/jobs/:id ---------- */
function handleGetJob(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return sendJson(res, 404, { success: false, error: "Job tidak ditemukan." });
  }

  // Kirim salinan ringkas job (tanpa field internal yang tak perlu)
  const publicFiles = job.files.map((f) => ({
    id: f.id,
    name: f.name,
    status: f.status,
    progressPercent: f.progressPercent,
    errorMessage: f.errorMessage,
    receivedBytes: f.receivedBytes,
    totalBytes: f.totalBytes,
  }));

  const elapsedSeconds = (Date.now() - job.startedAt) / 1000;
  const speedBps = elapsedSeconds > 0 ? job.totalBytesDownloaded / elapsedSeconds : 0;

  let etaSeconds = null;
  if (job.completedCount > 0 && job.completedCount < job.totalCount) {
    const avgTimePerFile = elapsedSeconds / job.completedCount;
    etaSeconds = avgTimePerFile * (job.totalCount - job.completedCount);
  } else if (job.completedCount >= job.totalCount) {
    etaSeconds = 0;
  }

  const newLogEntries = job.log.slice(job._lastSentLogIndex || 0);
  job._lastSentLogIndex = job.log.length;

  sendJson(res, 200, {
    success: true,
    id: job.id,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    cancelled: job.cancelled,
    speedBps,
    etaSeconds,
    files: publicFiles,
    newLogEntries: newLogEntries.map((e) => ({ message: e.message, level: e.level })),
    done: job.completedCount >= job.totalCount || job.cancelled,
  });
}

/* ---------- ROUTE: POST /api/jobs/:id/cancel ---------- */
function handleCancelJob(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return sendJson(res, 404, { success: false, error: "Job tidak ditemukan." });
  }
  job.cancelled = true;
  addJobLog(job, "Permintaan pembatalan diterima.", "warning");
  sendJson(res, 200, { success: true });
}

/* ---------- ROUTE: GET /api/jobs/:id/files/:fileId ----------
   Mengalirkan (stream) file yang sudah selesai diunduh server ke
   browser pengguna sebagai file attachment. Ini diperlukan karena
   di mode online, file tersimpan di disk SERVER (Render dsb),
   bukan di komputer pengguna — beda dengan mode lokal di mana
   "downloads/" ada langsung di PC yang menjalankan server.js.
   ------------------------------------------------------------ */
async function handleDownloadResultFile(req, res, jobId, fileId) {
  const job = jobs.get(jobId);
  if (!job) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Job tidak ditemukan.");
  }

  const fileState = job.files.find((f) => f.id === fileId);
  if (!fileState || fileState.status !== "completed" || !fileState.savedPath) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("File belum tersedia atau tidak ditemukan.");
  }

  try {
    const stat = await fsp.stat(fileState.savedPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileState.name)}"`,
    });
    fs.createReadStream(fileState.savedPath).pipe(res);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("File tidak ditemukan di server (mungkin sudah dibersihkan otomatis).");
  }
}

/* ------------------------------------------------------------
   PEMBERSIHAN OTOMATIS FOLDER JOB LAMA
   Hosting gratis biasanya berkuota disk kecil. Folder job yang
   lebih tua dari MAX_JOB_AGE_MS dihapus otomatis agar disk tidak
   penuh oleh file yang sudah tidak relevan/tidak diambil pengguna.
   ------------------------------------------------------------ */
const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1000; // 2 jam

async function cleanupOldJobFolders() {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    if (now - job.startedAt > MAX_JOB_AGE_MS) {
      const jobDir = getJobDownloadDir(jobId);
      await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(jobId);
    }
  }
}


async function serveStaticFile(req, res) {
  let requestPath = decodeURIComponent(req.url.split("?")[0]);
  if (requestPath === "/") requestPath = "/index.html";

  // Cegah path traversal ("../") saat mengakses file statis
  const safePath = path.normalize(path.join(PUBLIC_DIR, requestPath));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const data = await fsp.readFile(safePath);
    const ext = path.extname(safePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
}

/* ---------- MAIN REQUEST HANDLER / ROUTER ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];

    if (req.method === "POST" && url === "/api/scan") {
      return await handleScan(req, res);
    }

    if (req.method === "POST" && url === "/api/download") {
      return await handleStartDownload(req, res);
    }

    const jobMatch = url.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
    if (req.method === "GET" && jobMatch) {
      return handleGetJob(req, res, jobMatch[1]);
    }

    const cancelMatch = url.match(/^\/api\/jobs\/([a-f0-9-]+)\/cancel$/i);
    if (req.method === "POST" && cancelMatch) {
      return handleCancelJob(req, res, cancelMatch[1]);
    }

    const fileDownloadMatch = url.match(/^\/api\/jobs\/([a-f0-9-]+)\/files\/([a-f0-9-]+)$/i);
    if (req.method === "GET" && fileDownloadMatch) {
      return await handleDownloadResultFile(req, res, fileDownloadMatch[1], fileDownloadMatch[2]);
    }

    // Selain endpoint API, layani sebagai file statis (frontend)
    return await serveStaticFile(req, res);

  } catch (err) {
    console.error("Kesalahan server tak terduga:", err);
    sendJson(res, 500, { success: false, error: "Kesalahan server internal." });
  }
});

ensureDownloadsDir().then(() => {
  server.listen(PORT, HOST, () => {
    console.log("============================================================");
    console.log(" MediaFire Folder Downloader — Server berjalan");
    console.log(`  Alamat lokal   : http://127.0.0.1:${PORT}`);
    console.log(`  Mendengarkan di: ${HOST}:${PORT}`);
    console.log(`  Folder unduhan : ${DOWNLOADS_DIR}`);
    console.log(" Tekan Ctrl+C untuk menghentikan server.");
    console.log("============================================================");
  });

  // Bersihkan folder job lama setiap 30 menit agar disk server
  // (terutama pada hosting gratis dengan kuota kecil) tidak penuh.
  setInterval(cleanupOldJobFolders, 30 * 60 * 1000);
});
