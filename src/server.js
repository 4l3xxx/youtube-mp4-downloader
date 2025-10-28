const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Config
const PORT = process.env.PORT || 3000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000); // 10 minutes

const app = express();

// Basic health endpoint
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Serve static files (front-end)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  extensions: ['html']
}));

// Utility: create a unique temp directory for each request
function makeTempDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmp4-'));
  return base;
}

// Utility: basic URL validation
function isLikelyUrl(str) {
  try {
    const u = new URL(str);
    return !!u.protocol && !!u.hostname;
  } catch (_) {
    return false;
  }
}

// Sanitize filename for headers and cross-OS safety
function sanitizeFileName(name) {
  // Remove control chars and Windows-forbidden characters
  return name
    .replace(/[\u0000-\u001F\u007F]+/g, '')
    .replace(/[<>:"/\\|?*]+/g, '')
    .trim();
}

// Encode filename* per RFC 5987 for UTF-8 names in headers
function encodeRFC5987(value) {
  return encodeURIComponent(value)
    .replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A');
}

// Optional: load cookies for yt-dlp to bypass YouTube bot checks in hosting environments
let COOKIES_FILE = null;
(() => {
  try {
    const b64 = process.env.YTDLP_COOKIES_BASE64 || '';
    if (b64) {
      // Write raw bytes to a well-known temp path used in Linux containers
      const buf = Buffer.from(b64, 'base64');
      const target = path.join('/tmp', 'cookies.txt');
      fs.writeFileSync(target, buf, { mode: 0o600 });
      COOKIES_FILE = target;
    } else {
      const fromEnv = process.env.YTDLP_COOKIES_PATH;
      const fallback = path.join(__dirname, '..', 'cookies.txt');
      const p = fromEnv || fallback;
      if (fs.existsSync(p)) COOKIES_FILE = p;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Warning: failed to load cookies file:', e && e.message ? e.message : e);
  }
})();

const DEFAULT_UA = process.env.YTDLP_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// GET /download?url=...
// Triggers a server-side yt-dlp + ffmpeg download to MP4, then streams as an attachment.
app.get('/download', async (req, res) => {
  const videoUrl = (req.query.url || '').toString().trim();
  const qualityParam = (req.query.quality || 'best').toString().trim();
  if (!videoUrl || !isLikelyUrl(videoUrl)) {
    return res.status(400).send('Invalid or missing URL.');
  }

  // Defensive: do not allow local network traversal
  try {
    const parsed = new URL(videoUrl);
    const host = parsed.hostname.toLowerCase();
    if (/(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/.test(host)) {
      return res.status(400).send('Local URLs are not allowed.');
    }
  } catch (_) {
    return res.status(400).send('Invalid URL.');
  }

  // Create temp working directory
  const workDir = makeTempDir();
  // Use video title for output name
  const outputTemplate = path.join(workDir, '%(title)s.%(ext)s');

  // yt-dlp command
  // Strategy:
  // - Select best video+audio, prefer MP4; fallback gracefully
  // - Merge output to mp4
  // - Re-encode audio to AAC for compatibility
  // - Constrain resolution if requested (pick highest <= requested)
  const allowedHeights = new Set(['144','240','360','480','720','1080','1440','2160']);
  const height = allowedHeights.has(qualityParam) ? parseInt(qualityParam, 10) : null;
  const format = height
    ? `bv*[ext=mp4][height<=${height}]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`
    : 'bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/b';

  const ytdlpArgs = [
    '-f', format,
    '--merge-output-format', 'mp4',
    // Force ffmpeg to keep video stream and convert audio to AAC always
    '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac -b:a 192k -movflags +faststart',
    '-o', outputTemplate,
    '--no-playlist',
    '--user-agent', DEFAULT_UA,
    '--referer', 'https://www.youtube.com/'
  ];

  if (COOKIES_FILE) {
    ytdlpArgs.push('--cookies', COOKIES_FILE);
  }

  // URL last
  ytdlpArgs.push(videoUrl);

  // Optionally restrict filename chars further
  // ytdlpArgs.push('--restrict-filenames');

  const child = spawn('yt-dlp', ytdlpArgs, {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => {
    if (stderrBuf.length < 4000) stderrBuf += d.toString();
  });

  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, DOWNLOAD_TIMEOUT_MS);

  child.on('error', (err) => {
    clearTimeout(timeout);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    if (err && err.code === 'ENOENT') {
      return res.status(500).send('Server is missing yt-dlp. Please install yt-dlp and ffmpeg.');
    }
    return res.status(500).send('Failed to start download process.');
  });

  child.on('close', (code) => {
    clearTimeout(timeout);
    if (code !== 0) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
      return res.status(500).send('Download failed.\n' + stderrBuf);
    }

    // Locate the produced file
    let produced;
    try {
      const entries = fs.readdirSync(workDir);
      produced = entries.find((f) => f.toLowerCase().endsWith('.mp4'));
    } catch (e) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
      return res.status(500).send('Failed to read output.');
    }

    if (!produced) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
      return res.status(500).send('No MP4 produced.');
    }

    const filePath = path.join(workDir, produced);

    // Set download headers
    res.setHeader('Content-Type', 'video/mp4');
    // Build safe Content-Disposition with ASCII fallback and UTF-8 filename*
    const baseName = path.parse(produced).name;
    const title = sanitizeFileName(baseName) || 'video';
    const asciiTitle = title.replace(/[^\x20-\x7E]+/g, '');
    const fallbackTitle = asciiTitle || 'video';
    const filenameStar = encodeRFC5987(`${title}.mp4`);
    res.setHeader('Content-Disposition', `attachment; filename="${fallbackTitle}.mp4"; filename*=UTF-8''${filenameStar}`);

    const readStream = fs.createReadStream(filePath);
    readStream.on('error', () => {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
      if (!res.headersSent) res.status(500).end('Failed to read file.'); else res.end();
    });
    res.on('close', () => {
      // Client disconnected or finished; cleanup temp dir
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    });
    readStream.pipe(res);
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});
