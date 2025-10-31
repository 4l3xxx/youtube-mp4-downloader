const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const youtubedl = require('youtube-dl-exec');

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

const DEFAULT_UA = process.env.YTDLP_UA || 'Mozilla/5.0';

// GET /download?url=...
// Triggers a server-side yt-dlp + ffmpeg download to MP4, then streams as an attachment.
app.get('/download', async (req, res) => {
  const videoUrl = (req.query.url || '').toString().trim();
  const qualityParam = (req.query.quality || 'best').toString().trim();
  const formatParam = (req.query.format || 'mp4').toString().trim().toLowerCase();
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

  // Branch by requested output format
  const isMp3 = formatParam === 'mp3';
  // Build options for youtube-dl-exec (auto converts camelCase to flags)
  let ytdlpOpts;
  if (isMp3) {
    ytdlpOpts = {
      binary: 'yt-dlp',
      format: 'bestaudio',
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: '0',
      output: outputTemplate,
      noPlaylist: true,
      userAgent: DEFAULT_UA,
      referer: 'https://www.youtube.com/'
    };
  } else {
    // Video (MP4): preserve existing behavior
    const allowedHeights = new Set(['144','240','360','480','720','1080','1440','2160']);
    const height = allowedHeights.has(qualityParam) ? parseInt(qualityParam, 10) : null;
    const format = height
      ? `bv*[ext=mp4][height<=${height}]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`
      : 'bv*[ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/b';

    ytdlpOpts = {
      binary: 'yt-dlp',
      format,
      mergeOutputFormat: 'mp4',
      postprocessorArgs: 'ffmpeg:-c:v copy -c:a aac -b:a 192k -movflags +faststart',
      output: outputTemplate,
      noPlaylist: true,
      userAgent: DEFAULT_UA,
      referer: 'https://www.youtube.com/'
    };
  }

  // Ensure yt-dlp uses cookies from Railway if present
  try {
    const cookiePath = path.join('/tmp', 'cookies.txt');
    if (fs.existsSync(cookiePath)) {
      ytdlpOpts.cookies = cookiePath;
    } else if (COOKIES_FILE) {
      ytdlpOpts.cookies = COOKIES_FILE;
    }
  } catch (_) {
    // ignore cookies if any fs error
  }

  // Spawn yt-dlp via youtube-dl-exec with URL (raw no longer needed)
  const child = youtubedl(videoUrl, ytdlpOpts, { shell: true, cwd: workDir });

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
      if (isMp3) {
        produced = entries.find((f) => f.toLowerCase().endsWith('.mp3'));
      } else {
        produced = entries.find((f) => f.toLowerCase().endsWith('.mp4'));
      }
    } catch (e) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
      return res.status(500).send('Failed to read output.');
    }

    if (!produced) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
      return res.status(500).send(isMp3 ? 'No MP3 produced.' : 'No MP4 produced.');
    }

    const filePath = path.join(workDir, produced);

    // Set download headers
    res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'video/mp4');
    // Build safe Content-Disposition with ASCII fallback and UTF-8 filename*
    const baseName = path.parse(produced).name;
    const title = sanitizeFileName(baseName) || 'video';
    const asciiTitle = title.replace(/[^\x20-\x7E]+/g, '');
    const fallbackTitle = asciiTitle || 'video';
    const filenameStar = encodeRFC5987(`${title}.${isMp3 ? 'mp3' : 'mp4'}`);
    res.setHeader('Content-Disposition', `attachment; filename="${fallbackTitle}.${isMp3 ? 'mp3' : 'mp4'}"; filename*=UTF-8''${filenameStar}`);

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
