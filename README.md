# MediaFire Folder Downloader

Aplikasi lokal untuk mengelola dan mengunduh file **publik** dari folder MediaFire — mirip JDownloader, tapi ringan: server Node.js kecil + antarmuka web modern (glassmorphism, dark mode).

Tidak melakukan bypass Premium, autentikasi, atau CAPTCHA. Jika folder/file memang memerlukan itu, aplikasi menampilkan pesan yang jelas, bukan mencoba menerobosnya.

## Kenapa butuh server (bukan cuma buka file HTML)?

Browser memblokir JavaScript di halaman web agar tidak bisa `fetch()` bebas ke domain lain (aturan CORS). MediaFire tidak mengizinkan permintaan semacam itu dari sembarang website. Untuk itu aplikasi ini menyertakan **server Node.js kecil** yang berjalan di komputer Anda sendiri — permintaan dari Node.js ke MediaFire adalah komunikasi server-ke-server yang **tidak tunduk pada CORS**, persis seperti cara kerja JDownloader atau aplikasi desktop lain.

Browser Anda hanya menampilkan antarmuka (`http://127.0.0.1:3939`) dan berbicara ke server lokal ini — bukan langsung ke MediaFire.

## Cara Menjalankan

Prasyarat: Node.js versi 18 ke atas sudah terpasang (`node -v` untuk memastikan).

1. Ekstrak folder proyek ini di komputer Anda.
2. Buka terminal / Command Prompt di folder tersebut.
3. Jalankan:
   ```
   node server.js
   ```
4. Akan muncul pesan:
   ```
   MediaFire Folder Downloader — Server berjalan
   Buka browser ke: http://127.0.0.1:3939
   ```
5. Buka alamat tersebut di browser (Chrome, Edge, Firefox, dll).
6. Biarkan jendela terminal tetap terbuka selama menggunakan aplikasi. Tutup dengan `Ctrl+C` jika sudah selesai.

Tidak perlu `npm install` — aplikasi ini sengaja dibuat tanpa dependency eksternal, hanya menggunakan modul bawaan Node.js.

## Cara Pakai

1. Tempel URL folder MediaFire publik (format `https://www.mediafire.com/folder/xxxxxxxxx/nama`).
2. Klik **Scan Folder** — server akan mengambil dan membaca daftar file.
3. Setiap file diberi label status:
   - **Tersedia** — bisa langsung diunduh.
   - **Dibatasi** — butuh password/tidak publik.
   - **Premium** — butuh akun Premium MediaFire.
4. Centang file yang diinginkan, atau gunakan **Pilih Semua**.
5. Klik **Download Terpilih** atau **Download Semua**.
6. Pantau progres keseluruhan dan progres per file secara real-time.
7. File hasil unduhan tersimpan otomatis di folder `downloads/` di dalam folder aplikasi ini.
8. Riwayat unduhan tersimpan di browser (LocalStorage) dan bisa dilihat lewat ikon jam di pojok kanan atas.
9. Pengaturan (jumlah unduhan bersamaan, retry otomatis, timeout) bisa diubah lewat ikon gerigi.

## Cara Deploy ke Render (akses online dari mana saja)

Render menjalankan `server.js` sebagai proses yang hidup terus-menerus — beda dengan Netlify/Vercel yang hanya menyajikan file statis dan **tidak bisa** menjalankan backend seperti ini.

### Opsi A — Lewat GitHub (direkomendasikan)
1. Upload folder proyek ini ke repository GitHub baru.
2. Buka [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**.
3. Hubungkan repository GitHub Anda.
4. Render akan otomatis mendeteksi `render.yaml` dan mengisi konfigurasi (Build Command: `npm install`, Start Command: `node server.js`).
5. Pilih plan **Free**, klik **Create Web Service**.
6. Tunggu proses build selesai (1-3 menit). Render akan memberi URL publik seperti `https://mediafire-folder-downloader.onrender.com`.

### Opsi B — Upload manual (tanpa GitHub)
1. Di dashboard Render, pilih **New** → **Web Service** → **Deploy an existing image or public repo** tidak tersedia untuk upload langsung; Render mengharuskan koneksi lewat Git. Jika tidak ingin pakai GitHub, alternatif termudah adalah [Railway](https://railway.app) yang mendukung upload langsung via CLI, atau tetap gunakan GitHub (gratis, cukup buat akun).

### Catatan penting untuk mode online
- **Free tier Render "tidur"** setelah ~15 menit tanpa aktivitas, dan perlu ~30-60 detik untuk "bangun" lagi saat diakses. Ini normal untuk tier gratis, bukan bug.
- File hasil download **tersimpan sementara di server**, bukan langsung ke perangkat Anda. Setelah proses selesai, klik tombol **"Simpan ke perangkat"** yang muncul di setiap file untuk mengunduhnya ke HP/PC Anda.
- File di server otomatis dihapus setelah 2 jam untuk menghemat kuota disk gratis — pastikan mengklik "Simpan ke perangkat" sebelum itu.
- Karena aplikasi ini publik, siapa pun yang tahu URL Render Anda bisa memakainya. Ini masih aman (tidak ada bypass Premium/autentikasi), tapi disarankan jangan bagikan URL ke sembarang orang jika ingin membatasi pemakaian bandwidth server.



```
mfd-app/
├── server.js         → Backend Node.js: fetch, parsing HTML MediaFire, download, job queue
├── package.json      → Metadata proyek (tanpa dependency eksternal)
├── render.yaml       → Konfigurasi auto-deploy untuk Render
├── .gitignore
├── public/
│   ├── index.html    → Struktur halaman
│   ├── style.css     → Styling glassmorphism + dark mode + responsive
│   └── script.js     → Frontend: UI, validasi, polling progress, riwayat, pengaturan
├── downloads/        → File hasil unduhan tersimpan sementara di sini (per sesi/job)
└── README.md
```

## Batasan yang Perlu Diketahui

- Parser HTML MediaFire didasarkan pada struktur halaman folder yang umum saat ini. Jika MediaFire mengubah struktur halaman mereka di masa depan, bagian `parseFolderHtml()` dan `resolveDirectDownloadLink()` di `server.js` mungkin perlu disesuaikan.
- Server hanya mendengarkan di `127.0.0.1` (localhost) — tidak diekspos ke jaringan luar secara default.
- Aplikasi tidak dan tidak akan pernah mencoba melewati Premium, CAPTCHA, atau login MediaFire.
