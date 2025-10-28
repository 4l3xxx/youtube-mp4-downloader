## YouTube ke MP4 (Server-side)

Aplikasi web sederhana untuk mengunduh video YouTube sebagai file MP4 menggunakan `yt-dlp` + `ffmpeg`. Front-end minimal, satu halaman.

### Fitur

- Input URL YouTube, unduh sebagai `.mp4` dengan audio.
- Pengunduhan dilakukan di server (aman terhadap pembatasan CORS/DRM yang tidak didukung klien).
- Browser akan memicu unduhan standar ke folder unduhan default perangkat.

### Catatan Penting (Keterbatasan Browser)

- Website tidak dapat memaksa file tersimpan ke folder tertentu (mis. `Downloads`/`Galeri`). Browser dan sistem yang menentukan lokasinya.
- Di desktop, file masuk ke folder unduhan default browser (biasanya `Downloads`).
- Di ponsel, file biasanya ke `Downloads`. Untuk masuk ke Galeri/Foto, pengguna mungkin perlu memindahkan atau menyimpan secara manual sesuai perangkat.

### Prasyarat Server

- Node.js 18+ (untuk menjalankan server).
- `yt-dlp` tersedia di `PATH` server.
- `ffmpeg` tersedia di `PATH` server (untuk mux video+audio jadi MP4).

Periksa versi dengan:

```
yt-dlp --version
ffmpeg -version
node -v
```

Instalasi contoh (Ubuntu):

```
sudo apt-get update
sudo apt-get install -y ffmpeg
pipx install yt-dlp  # atau: pip install yt-dlp --break-system-packages
```

Windows:

- Unduh `yt-dlp.exe` dan `ffmpeg.exe`, taruh di folder yang ada di `PATH` (atau folder proyek dan tambahkan ke `PATH`).

### Jalankan Lokal

```
npm install
npm start
```

Lalu buka: http://localhost:3000

### Deploy Production

- Pastikan `yt-dlp` dan `ffmpeg` tersedia di lingkungan deploy.
- Jalankan `node src/server.js` (atau pakai prosesor seperti PM2/systemd).

#### Catatan: YouTube bot check (Railway/VPS)

Di sebagian hosting (mis. Railway), YouTube bisa meminta login/cek bot sehingga `yt-dlp` gagal dengan pesan seperti:

> Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies

Solusi (pilih salah satu):

- Ekspor cookies YouTube dari browser Anda (format Netscape), lalu set sebagai environment variable base64:
  1. Ekspor cookies ke `cookies.txt` (pakai ekstensi "Get cookies.txt").
  2. Encode ke Base64:
     - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cookies.txt'))`
     - Linux/macOS: `base64 -w0 cookies.txt`
  3. Di Railway, tambah Variable: `YTDLP_COOKIES_BASE64` dengan nilai base64 di atas.
  4. Opsional: tambahkan `YTDLP_UA` untuk user-agent kustom.
  - Alternatif: unggah `cookies.txt` ke server dan set `YTDLP_COOKIES_PATH` ke path file tersebut.
- Opsional: set `YTDLP_UA` untuk user-agent kustom. Default sudah menggunakan UA Chrome desktop.

Implementasi backend:

- Jika `YTDLP_COOKIES_BASE64` di-set, server decode dan menulis file ke `/tmp/cookies.txt`, lalu memanggil yt-dlp dengan:
  - `--cookies /tmp/cookies.txt`
  - `--user-agent "$YTDLP_UA atau default Chrome"`
  - `--referer https://www.youtube.com/`

Dengan cara di atas, unduhan tetap berjalan meski IP hosting terkena verifikasi.

Contoh Dockerfile (opsional, sesuaikan sumber yt-dlp/ffmpeg):

```
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

### Cara Pakai

1. Masukkan URL video YouTube (mis. `https://www.youtube.com/watch?v=...`).
2. Klik "Unduh MP4".
3. Tunggu server menyiapkan dan browser akan memulai unduhan otomatis.

### Batasan & Kepatuhan

- Tunduk pada Ketentuan Layanan YouTube. Unduh hanya konten yang Anda miliki haknya.
- Beberapa video (DRM/age-restricted/region-locked) mungkin tidak dapat diunduh.

### Konfigurasi Tambahan

- `PORT`: port server (default `3000`).
- `DOWNLOAD_TIMEOUT_MS`: timeout unduhan per permintaan (default `600000` ms / 10 menit).
