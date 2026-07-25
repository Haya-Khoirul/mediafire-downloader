/* ============================================================
   SCRIPT.JS (FRONTEND)
   Frontend ini TIDAK melakukan parsing atau fetch ke MediaFire
   secara langsung. Semua itu dikerjakan oleh server.js (backend
   Node.js yang jalan di komputer yang sama, tanpa batasan CORS).

   Frontend hanya:
   1. Mengirim URL folder ke POST /api/scan, menampilkan hasilnya.
   2. Mengirim daftar file terpilih ke POST /api/download untuk
      memulai job download di server.
   3. Polling GET /api/jobs/:id secara berkala untuk menampilkan
      progress terkini (mirip cara JDownloader menampilkan progress
      dari proses background-nya).
   4. Mengelola UI: validasi input, riwayat (LocalStorage), toast,
      log aktivitas, dan pengaturan.
   ============================================================ */

const API_BASE = ""; // same-origin (server & frontend disajikan dari host yang sama)
const POLL_INTERVAL_MS = 800;

/* ------------------------------------------------------------
   MODUL UTILS (helper umum, tetap dipisah agar mudah dikembangkan)
   ------------------------------------------------------------ */
const Utils = (() => {

  function isValidMediaFireFolderUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url.trim());
      const isHost = /(^|\.)mediafire\.com$/i.test(parsed.hostname);
      const isFolderPath = /\/folder\//i.test(parsed.pathname);
      return isHost && isFolderPath;
    } catch {
      return false;
    }
  }

  function formatBytes(bytes, decimals = 2) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return "Tidak diketahui";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const value = parseFloat((bytes / Math.pow(k, i)).toFixed(decimals));
    return `${value} ${sizes[i]}`;
  }

  function formatDuration(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined || !isFinite(totalSeconds) || totalSeconds < 0) return "--";
    totalSeconds = Math.round(totalSeconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}j ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}d`;
    return `${seconds} detik`;
  }

  function formatClockTime(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function formatFullDate(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

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

  function getFileExtensionLabel(filename) {
    if (!filename || !filename.includes(".")) return "FILE";
    return filename.split(".").pop().toUpperCase();
  }

  const FILE_TYPE_ICONS = {
    document: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2v6h6M9 13h6M9 17h6M9 9h1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    spreadsheet: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18" stroke="currentColor" stroke-width="2"/></svg>`,
    presentation: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 21l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    image: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" stroke-width="2"/><path d="M21 15l-5-5L5 21" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
    audio: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2"/></svg>`,
    video: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="5" width="15" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M17 10l5-3v10l-5-3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
    archive: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 3v18M9 7h2M9 11h2M9 15h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    app: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="16" height="20" rx="2" stroke="currentColor" stroke-width="2"/><path d="M9 18h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    unknown: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  };

  function getFileTypeIcon(type) {
    return FILE_TYPE_ICONS[type] || FILE_TYPE_ICONS.unknown;
  }

  const STORAGE_KEYS = { HISTORY: "mfd_download_history", SETTINGS: "mfd_settings" };

  function readStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function generateId(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function debounce(fn, delay = 300) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(str) {
    if (typeof str !== "string") return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatSpeed(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0 || !isFinite(bytesPerSecond)) return "-- KB/s";
    return `${formatBytes(bytesPerSecond)}/s`;
  }

  const TOAST_ICONS = {
    success: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 11l3 3L22 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6m0-6l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    info: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 16v-4m0-4h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  };

  function showToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span class="toast-message">${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("toast-exit");
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }

  function logActivity(message, level = "info") {
    const logContainer = document.getElementById("activityLog");
    if (!logContainer) return;
    const emptyMsg = logContainer.querySelector(".log-empty");
    if (emptyMsg) emptyMsg.remove();
    const entry = document.createElement("div");
    entry.className = `log-entry log-${level}`;
    entry.innerHTML = `<span class="log-time">[${formatClockTime()}]</span><span class="log-message">${escapeHtml(message)}</span>`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  return {
    isValidMediaFireFolderUrl, formatBytes, formatDuration, formatClockTime, formatFullDate,
    detectFileType, getFileExtensionLabel, getFileTypeIcon, readStorage, writeStorage,
    generateId, debounce, sleep, escapeHtml, formatSpeed, showToast, logActivity, STORAGE_KEYS,
  };
})();

/* ------------------------------------------------------------
   MODUL API CLIENT — semua komunikasi ke backend lokal
   ------------------------------------------------------------ */
const Api = (() => {

  async function scanFolder(url) {
    const res = await fetch(`${API_BASE}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    return res.json();
  }

  async function startDownload(files, settings) {
    const res = await fetch(`${API_BASE}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, settings }),
    });
    return res.json();
  }

  async function getJobStatus(jobId) {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}`);
    return res.json();
  }

  async function cancelJob(jobId) {
    const res = await fetch(`${API_BASE}/api/jobs/${jobId}/cancel`, { method: "POST" });
    return res.json();
  }

  async function pingServer() {
    try {
      const res = await fetch(`${API_BASE}/`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  return { scanFolder, startDownload, getJobStatus, cancelJob, pingServer };
})();

/* ------------------------------------------------------------
   ENTRY POINT UTAMA
   ------------------------------------------------------------ */
document.addEventListener("DOMContentLoaded", () => {

  const el = {
    serverStatusBadge: document.getElementById("serverStatusBadge"),

    folderUrlInput: document.getElementById("folderUrlInput"),
    btnClearUrl: document.getElementById("btnClearUrl"),
    btnScan: document.getElementById("btnScan"),
    urlValidationMsg: document.getElementById("urlValidationMsg"),
    scanStatus: document.getElementById("scanStatus"),
    scanStatusText: document.getElementById("scanStatusText"),

    fileListSection: document.getElementById("fileListSection"),
    fileListContainer: document.getElementById("fileListContainer"),
    fileCountBadge: document.getElementById("fileCountBadge"),
    btnSelectAll: document.getElementById("btnSelectAll"),
    btnDeselectAll: document.getElementById("btnDeselectAll"),
    selectionSummary: document.getElementById("selectionSummary"),
    btnDownloadSelected: document.getElementById("btnDownloadSelected"),
    btnDownloadAll: document.getElementById("btnDownloadAll"),

    downloadSection: document.getElementById("downloadSection"),
    btnCancelDownload: document.getElementById("btnCancelDownload"),
    overallProgressLabel: document.getElementById("overallProgressLabel"),
    overallProgressPercent: document.getElementById("overallProgressPercent"),
    overallProgressBar: document.getElementById("overallProgressBar"),
    downloadSpeedLabel: document.getElementById("downloadSpeedLabel"),
    etaLabel: document.getElementById("etaLabel"),
    perFileProgressContainer: document.getElementById("perFileProgressContainer"),

    btnClearLog: document.getElementById("btnClearLog"),

    btnHistory: document.getElementById("btnHistory"),
    historyModal: document.getElementById("historyModal"),
    btnCloseHistory: document.getElementById("btnCloseHistory"),
    historyListContainer: document.getElementById("historyListContainer"),
    btnClearHistory: document.getElementById("btnClearHistory"),

    btnSettings: document.getElementById("btnSettings"),
    settingsModal: document.getElementById("settingsModal"),
    btnCloseSettings: document.getElementById("btnCloseSettings"),
    settingConcurrent: document.getElementById("settingConcurrent"),
    settingRetry: document.getElementById("settingRetry"),
    settingTimeout: document.getElementById("settingTimeout"),
    btnSaveSettings: document.getElementById("btnSaveSettings"),
  };

  let currentFiles = [];
  let perFileProgressEls = {};
  let activeJobId = null;
  let pollTimer = null;

  /* ---------------- CEK KONEKSI SERVER SECARA BERKALA ---------------- */
  async function checkServerStatus() {
    const online = await Api.pingServer();
    el.serverStatusBadge.classList.toggle("status-offline", !online);
    el.serverStatusBadge.innerHTML = online
      ? `<span class="status-dot"></span> Terhubung`
      : `<span class="status-dot"></span> Terputus`;
  }

  /* ---------------- PENGATURAN ---------------- */
  function initSettings() {
    const saved = Utils.readStorage(Utils.STORAGE_KEYS.SETTINGS, {
      maxConcurrent: 2, maxRetry: 3, timeoutSeconds: 30,
    });
    el.settingConcurrent.value = saved.maxConcurrent;
    el.settingRetry.value = saved.maxRetry;
    el.settingTimeout.value = saved.timeoutSeconds;
  }

  function getCurrentSettings() {
    return Utils.readStorage(Utils.STORAGE_KEYS.SETTINGS, {
      maxConcurrent: 2, maxRetry: 3, timeoutSeconds: 30,
    });
  }

  function clampNumber(value, min, max, fallback) {
    if (isNaN(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function saveSettings() {
    const newSettings = {
      maxConcurrent: clampNumber(parseInt(el.settingConcurrent.value, 10), 1, 10, 2),
      maxRetry: clampNumber(parseInt(el.settingRetry.value, 10), 0, 10, 3),
      timeoutSeconds: clampNumber(parseInt(el.settingTimeout.value, 10), 5, 300, 30),
    };
    Utils.writeStorage(Utils.STORAGE_KEYS.SETTINGS, newSettings);
    el.settingConcurrent.value = newSettings.maxConcurrent;
    el.settingRetry.value = newSettings.maxRetry;
    el.settingTimeout.value = newSettings.timeoutSeconds;
    closeSettingsModal();
    Utils.showToast("Pengaturan berhasil disimpan.", "success");
    Utils.logActivity("Pengaturan diperbarui.", "info");
  }

  /* ---------------- VALIDASI INPUT URL ---------------- */
  const validateUrlInput = Utils.debounce(() => {
    const url = el.folderUrlInput.value.trim();
    el.btnClearUrl.hidden = url.length === 0;

    if (url.length === 0) {
      hideValidationMessage();
      return;
    }
    if (!Utils.isValidMediaFireFolderUrl(url)) {
      showValidationMessage("URL tidak valid. Gunakan format: https://www.mediafire.com/folder/xxxxxxxxx/nama");
      el.folderUrlInput.classList.add("invalid");
    } else {
      hideValidationMessage();
      el.folderUrlInput.classList.remove("invalid");
    }
  }, 350);

  function showValidationMessage(msg) {
    el.urlValidationMsg.textContent = msg;
    el.urlValidationMsg.hidden = false;
  }

  function hideValidationMessage() {
    el.urlValidationMsg.hidden = true;
  }

  /* ---------------- SCAN FOLDER (via backend) ---------------- */
  async function handleScanFolder() {
    const url = el.folderUrlInput.value.trim();

    if (!Utils.isValidMediaFireFolderUrl(url)) {
      showValidationMessage("Masukkan URL folder MediaFire yang valid sebelum memindai.");
      Utils.showToast("URL folder tidak valid.", "error");
      return;
    }

    hideValidationMessage();
    resetFileListUI();
    setScanStatus(true, "Menghubungi MediaFire lewat server lokal...");
    Utils.logActivity(`Memulai scan folder: ${url}`, "info");

    let result;
    try {
      result = await Api.scanFolder(url);
    } catch (err) {
      setScanStatus(false);
      Utils.logActivity(`Tidak dapat menghubungi server lokal: ${err.message}`, "error");
      Utils.showToast("Tidak dapat menghubungi server lokal. Pastikan 'node server.js' sedang berjalan.", "error", 6000);
      return;
    }

    setScanStatus(false);

    if (!result.success) {
      Utils.logActivity(`Scan gagal: ${result.error}`, "error");
      Utils.showToast(result.error, "error", 6000);
      return;
    }

    currentFiles = result.files;
    Utils.logActivity(`Berhasil menemukan ${currentFiles.length} file dalam folder "${result.folderName || "Tanpa Nama"}".`, "success");
    Utils.showToast(`Ditemukan ${currentFiles.length} file.`, "success");
    renderFileList();
  }

  function setScanStatus(isScanning, text) {
    el.scanStatus.hidden = !isScanning;
    el.btnScan.disabled = isScanning;
    if (text) el.scanStatusText.textContent = text;
  }

  /* ---------------- RENDER DAFTAR FILE ---------------- */
  function renderFileList() {
    el.fileListContainer.innerHTML = "";
    el.fileCountBadge.textContent = currentFiles.length;
    el.fileListSection.hidden = false;

    const tagMap = {
      available: { cls: "tag-available", label: "Tersedia" },
      restricted: { cls: "tag-restricted", label: "Dibatasi" },
      premium: { cls: "tag-premium", label: "Premium" },
    };

    currentFiles.forEach((file) => {
      const isAvailable = file.status === "available";
      const tag = tagMap[file.status] || tagMap.available;

      const item = document.createElement("div");
      item.className = `file-item${isAvailable ? "" : " disabled-item"}`;
      item.dataset.fileId = file.id;

      item.innerHTML = `
        <input type="checkbox" class="file-checkbox" ${isAvailable ? "" : "disabled"} aria-label="Pilih ${Utils.escapeHtml(file.name)}" />
        <span class="file-type-icon">${Utils.getFileTypeIcon(file.type)}</span>
        <div class="file-info">
          <div class="file-name" title="${Utils.escapeHtml(file.name)}">${Utils.escapeHtml(file.name)}</div>
          <div class="file-meta">
            <span>${Utils.formatBytes(file.sizeBytes)}</span>
            <span>·</span>
            <span>${Utils.getFileExtensionLabel(file.name)}</span>
          </div>
        </div>
        <span class="file-status-tag ${tag.cls}">${tag.label}</span>
      `;

      item.querySelector(".file-checkbox").addEventListener("change", updateSelectionSummary);
      el.fileListContainer.appendChild(item);
    });

    updateSelectionSummary();
  }

  function resetFileListUI() {
    currentFiles = [];
    el.fileListContainer.innerHTML = "";
    el.fileListSection.hidden = true;
    el.fileCountBadge.textContent = "0";
    updateSelectionSummary();
  }

  function updateSelectionSummary() {
    const checkboxes = el.fileListContainer.querySelectorAll(".file-checkbox");
    let selectedCount = 0;
    let totalSize = 0;

    checkboxes.forEach((cb, index) => {
      if (cb.checked) {
        selectedCount++;
        const file = currentFiles[index];
        if (file && file.sizeBytes) totalSize += file.sizeBytes;
      }
    });

    el.selectionSummary.textContent = `${selectedCount} file dipilih · ${Utils.formatBytes(totalSize)}`;
    el.btnDownloadSelected.disabled = selectedCount === 0;

    const availableCount = currentFiles.filter((f) => f.status === "available").length;
    el.btnDownloadAll.disabled = availableCount === 0;
  }

  function selectAllFiles() {
    el.fileListContainer.querySelectorAll(".file-checkbox:not(:disabled)").forEach((cb) => (cb.checked = true));
    updateSelectionSummary();
  }

  function deselectAllFiles() {
    el.fileListContainer.querySelectorAll(".file-checkbox").forEach((cb) => (cb.checked = false));
    updateSelectionSummary();
  }

  /* ---------------- MULAI DOWNLOAD (via backend) ---------------- */
  function handleDownloadSelected() {
    const checkboxes = el.fileListContainer.querySelectorAll(".file-checkbox");
    const selectedFiles = [];
    checkboxes.forEach((cb, index) => {
      if (cb.checked) selectedFiles.push(currentFiles[index]);
    });

    if (selectedFiles.length === 0) {
      Utils.showToast("Pilih minimal satu file terlebih dahulu.", "warning");
      return;
    }
    beginDownloadSession(selectedFiles);
  }

  function handleDownloadAll() {
    const availableFiles = currentFiles.filter((f) => f.status === "available");
    if (availableFiles.length === 0) {
      Utils.showToast("Tidak ada file yang tersedia untuk diunduh.", "warning");
      return;
    }
    beginDownloadSession(availableFiles);
  }

  async function beginDownloadSession(files) {
    el.downloadSection.hidden = false;
    el.perFileProgressContainer.innerHTML = "";
    perFileProgressEls = {};

    files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "per-file-item";
      row.innerHTML = `
        <div class="per-file-top">
          <span class="per-file-name" title="${Utils.escapeHtml(file.name)}">${Utils.escapeHtml(file.name)}</span>
          <span class="per-file-status status-waiting" data-role="status">Menunggu</span>
        </div>
        <div class="per-file-track">
          <div class="per-file-fill" data-role="fill" style="width:0%"></div>
        </div>
        <a class="per-file-download-btn" data-role="downloadBtn" hidden download>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v12m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Simpan ke perangkat
        </a>
      `;
      el.perFileProgressContainer.appendChild(row);
      perFileProgressEls[file.id] = row;
    });

    el.downloadSection.scrollIntoView({ behavior: "smooth", block: "nearest" });

    const settings = getCurrentSettings();

    let result;
    try {
      result = await Api.startDownload(files, settings);
    } catch (err) {
      Utils.showToast("Gagal memulai download: tidak dapat menghubungi server lokal.", "error");
      Utils.logActivity(`Gagal memulai download: ${err.message}`, "error");
      return;
    }

    if (!result.success) {
      Utils.showToast(result.error || "Gagal memulai download.", "error");
      return;
    }

    activeJobId = result.jobId;
    Utils.logActivity(`Memulai download ${files.length} file (maks ${settings.maxConcurrent} bersamaan).`, "info");
    startPollingJob(activeJobId, files);
  }

  /* ---------------- POLLING PROGRESS JOB ---------------- */
  function startPollingJob(jobId, filesSnapshot) {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      let status;
      try {
        status = await Api.getJobStatus(jobId);
      } catch (err) {
        return; // biarkan poll berikutnya mencoba lagi
      }

      if (!status.success) return;

      // Tampilkan log baru dari server
      (status.newLogEntries || []).forEach((entry) => {
        Utils.logActivity(entry.message, entry.level);
      });

      // Update progress per file
      status.files.forEach((f) => {
        const row = perFileProgressEls[f.id];
        if (!row) return;

        const statusEl = row.querySelector('[data-role="status"]');
        const fillEl = row.querySelector('[data-role="fill"]');

        const statusLabels = {
          waiting: "Menunggu", downloading: "Mengunduh", retrying: "Mencoba Ulang",
          completed: "Selesai", error: "Gagal", cancelled: "Dibatalkan",
        };

        statusEl.textContent = statusLabels[f.status] || f.status;
        statusEl.className = `per-file-status status-${f.status}`;
        fillEl.style.width = `${f.progressPercent}%`;
        fillEl.className = "per-file-fill";
        if (f.status === "completed") {
          fillEl.classList.add("fill-completed");
          const downloadBtn = row.querySelector('[data-role="downloadBtn"]');
          if (downloadBtn && downloadBtn.hidden) {
            downloadBtn.href = `${API_BASE}/api/jobs/${jobId}/files/${f.id}`;
            downloadBtn.hidden = false;
          }
        }
        if (f.status === "error") fillEl.classList.add("fill-error");
      });

      // Update progress keseluruhan
      const percent = status.totalCount > 0 ? Math.round((status.completedCount / status.totalCount) * 100) : 0;
      el.overallProgressLabel.textContent = `${status.completedCount} / ${status.totalCount} file selesai`;
      el.overallProgressPercent.textContent = `${percent}%`;
      el.overallProgressBar.style.width = `${percent}%`;
      el.downloadSpeedLabel.textContent = Utils.formatSpeed(status.speedBps);
      el.etaLabel.textContent = `Estimasi: ${Utils.formatDuration(status.etaSeconds)}`;

      // Simpan riwayat begitu masing-masing file selesai/gagal (idempoten
      // berdasarkan status yang sudah difinalisasi)
      status.files.forEach((f) => saveHistoryIfFinal(f, filesSnapshot));

      if (status.done) {
        clearInterval(pollTimer);
        pollTimer = null;
        const successCount = status.files.filter((f) => f.status === "completed").length;
        Utils.showToast(
          status.cancelled ? "Download dibatalkan." : `Selesai: ${successCount}/${status.totalCount} file berhasil diunduh.`,
          status.cancelled ? "warning" : "success",
          5000
        );
      }
    }, POLL_INTERVAL_MS);
  }

  const savedHistoryIds = new Set();
  function saveHistoryIfFinal(fileStatus, filesSnapshot) {
    const isFinal = ["completed", "error", "cancelled"].includes(fileStatus.status);
    if (!isFinal || savedHistoryIds.has(fileStatus.id)) return;
    savedHistoryIds.add(fileStatus.id);

    const original = filesSnapshot.find((f) => f.id === fileStatus.id);
    const history = Utils.readStorage(Utils.STORAGE_KEYS.HISTORY, []);
    history.unshift({
      id: Utils.generateId("hist"),
      name: fileStatus.name,
      sizeBytes: original ? original.sizeBytes : null,
      success: fileStatus.status === "completed",
      errorMessage: fileStatus.errorMessage || null,
      timestamp: Date.now(),
    });
    Utils.writeStorage(Utils.STORAGE_KEYS.HISTORY, history.slice(0, 200));
  }

  /* ---------------- BATALKAN DOWNLOAD ---------------- */
  async function handleCancelDownload() {
    if (!activeJobId) return;
    try {
      await Api.cancelJob(activeJobId);
      Utils.logActivity("Membatalkan proses download...", "warning");
    } catch (err) {
      Utils.showToast("Gagal mengirim permintaan pembatalan.", "error");
    }
  }

  /* ---------------- MODAL: RIWAYAT ---------------- */
  function openHistoryModal() {
    renderHistoryList();
    el.historyModal.hidden = false;
  }

  function closeHistoryModal() {
    el.historyModal.hidden = true;
  }

  function renderHistoryList() {
    const history = Utils.readStorage(Utils.STORAGE_KEYS.HISTORY, []);
    el.historyListContainer.innerHTML = "";

    if (history.length === 0) {
      el.historyListContainer.innerHTML = `<div class="history-empty">Belum ada riwayat download.</div>`;
      return;
    }

    history.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "history-item";
      item.innerHTML = `
        <div class="history-item-top">
          <span>${Utils.escapeHtml(entry.name)}</span>
          <span style="color:${entry.success ? "var(--accent-success)" : "var(--accent-danger)"}">${entry.success ? "Berhasil" : "Gagal"}</span>
        </div>
        <div class="history-item-meta">
          ${Utils.formatFullDate(new Date(entry.timestamp))} · ${Utils.formatBytes(entry.sizeBytes)}
          ${entry.errorMessage ? ` · ${Utils.escapeHtml(entry.errorMessage)}` : ""}
        </div>
      `;
      el.historyListContainer.appendChild(item);
    });
  }

  function clearHistory() {
    Utils.writeStorage(Utils.STORAGE_KEYS.HISTORY, []);
    renderHistoryList();
    Utils.showToast("Riwayat download telah dihapus.", "info");
  }

  /* ---------------- MODAL: PENGATURAN ---------------- */
  function openSettingsModal() {
    el.settingsModal.hidden = false;
  }

  function closeSettingsModal() {
    el.settingsModal.hidden = true;
  }

  /* ---------------- LOG ---------------- */
  function clearActivityLog() {
    document.getElementById("activityLog").innerHTML = `<div class="log-empty">Belum ada aktivitas.</div>`;
  }

  /* ---------------- EVENT LISTENERS ---------------- */
  function attachEventListeners() {
    el.folderUrlInput.addEventListener("input", validateUrlInput);
    el.btnClearUrl.addEventListener("click", () => {
      el.folderUrlInput.value = "";
      el.folderUrlInput.classList.remove("invalid");
      hideValidationMessage();
      el.btnClearUrl.hidden = true;
      el.folderUrlInput.focus();
    });

    el.btnScan.addEventListener("click", handleScanFolder);
    el.folderUrlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleScanFolder();
    });

    el.btnSelectAll.addEventListener("click", selectAllFiles);
    el.btnDeselectAll.addEventListener("click", deselectAllFiles);
    el.btnDownloadSelected.addEventListener("click", handleDownloadSelected);
    el.btnDownloadAll.addEventListener("click", handleDownloadAll);

    el.btnCancelDownload.addEventListener("click", handleCancelDownload);
    el.btnClearLog.addEventListener("click", clearActivityLog);

    el.btnHistory.addEventListener("click", openHistoryModal);
    el.btnCloseHistory.addEventListener("click", closeHistoryModal);
    el.btnClearHistory.addEventListener("click", clearHistory);
    el.historyModal.addEventListener("click", (e) => {
      if (e.target === el.historyModal) closeHistoryModal();
    });

    el.btnSettings.addEventListener("click", openSettingsModal);
    el.btnCloseSettings.addEventListener("click", closeSettingsModal);
    el.btnSaveSettings.addEventListener("click", saveSettings);
    el.settingsModal.addEventListener("click", (e) => {
      if (e.target === el.settingsModal) closeSettingsModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeHistoryModal();
        closeSettingsModal();
      }
    });
  }

  /* ---------------- INISIALISASI ---------------- */
  function init() {
    initSettings();
    attachEventListeners();
    checkServerStatus();
    setInterval(checkServerStatus, 10000);
    Utils.logActivity("Aplikasi siap digunakan. Server lokal terhubung.", "info");
  }

  init();
});
