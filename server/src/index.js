// Records By Grevo — Bunny upload proxy (multi-tenant)
// Each upload request supplies its own Bunny credentials via headers; the
// proxy keeps only an `UPLOAD_SECRET` (shared team password) and CORS config.

import express from 'express';
import https from 'node:https';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  UPLOAD_SECRET,
  PORT = 8080,
  ALLOWED_ORIGINS = '*',
} = process.env;

if (!UPLOAD_SECRET) {
  console.error('[fatal] Missing required env var: UPLOAD_SECRET');
  process.exit(1);
}

const ALLOWED = String(ALLOWED_ORIGINS).split(',').map((s) => s.trim());
const ALLOW_ALL = ALLOWED.includes('*');

const app = express();
app.disable('x-powered-by');

// ────── CORS ──────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_ALL) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-upload-secret, x-bunny-zone, x-bunny-host, x-bunny-key, x-pull-zone, x-stream-library, x-stream-key'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ────── Health ──────
app.get('/', (_req, res) => {
  res.json({
    name: 'records-by-grevo-proxy',
    status: 'ok',
    mode: 'multi-tenant',
    convert: 'mp4',
    stream: true,
    info: 'Storage: headers x-bunny-zone, x-bunny-host, x-bunny-key, x-pull-zone. Stream: x-stream-library, x-stream-key.',
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ────── Helpers ──────
function checkSecret(req, res) {
  const secret = req.headers['x-upload-secret'];
  if (!secret || secret !== UPLOAD_SECRET) {
    res.status(401).json({ ok: false, error: 'Invalid upload secret' });
    return false;
  }
  return true;
}

function readBunnyCreds(req, res) {
  const zone = String(req.headers['x-bunny-zone'] || '').trim();
  const host = String(req.headers['x-bunny-host'] || 'storage.bunnycdn.com').trim();
  const key = String(req.headers['x-bunny-key'] || '').trim();
  let pull = String(req.headers['x-pull-zone'] || '').trim().replace(/\/+$/, '');
  // Ensure scheme — user may have provided bare hostname
  if (pull && !/^https?:\/\//i.test(pull)) pull = 'https://' + pull;

  if (!zone || !key || !pull) {
    res.status(400).json({
      ok: false,
      error:
        'Missing Bunny credentials. Required headers: x-bunny-zone, x-bunny-key, x-pull-zone',
    });
    return null;
  }
  return { zone, host, key, pull };
}

// Replace Czech / accented characters with ASCII fallback, then strip what
// remains unsafe for URLs. Spaces become underscores.
function transliterate(s) {
  const map = {
    á: 'a', č: 'c', ď: 'd', é: 'e', ě: 'e', í: 'i', ň: 'n', ó: 'o',
    ř: 'r', š: 's', ť: 't', ú: 'u', ů: 'u', ý: 'y', ž: 'z',
    Á: 'A', Č: 'C', Ď: 'D', É: 'E', Ě: 'E', Í: 'I', Ň: 'N', Ó: 'O',
    Ř: 'R', Š: 'S', Ť: 'T', Ú: 'U', Ů: 'U', Ý: 'Y', Ž: 'Z',
  };
  return s.replace(/[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/g, (c) => map[c] || c);
}

function sanitizeName(input) {
  const base = String(input || '').replace(/\\/g, '/').split('/').pop();
  const ascii = transliterate(base);
  return ascii
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200) || 'recording';
}

function sanitizeFolder(input) {
  const cleaned = String(input || '')
    .replace(/\\/g, '/')
    .replace(/\.\.+/g, '')
    .replace(/[^a-zA-Z0-9._\-/]/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '');
  if (!cleaned) return '';
  return cleaned.endsWith('/') ? cleaned : cleaned + '/';
}

// ────── WebM → MP4 conversion (native ffmpeg) ──────
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000; // kill runaway conversions after 30 min
const CONVERT_REQ_TIMEOUT_MS = 35 * 60 * 1000; // keep the HTTP response alive meanwhile

function runFfmpeg(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inPath,
      // MediaRecorder WebM reports a bogus 1000 fps nominal rate — the fps
      // filter ignores it and resamples by real PTS to smooth CFR 30, which
      // every client player (QuickTime/Safari) handles reliably.
      '-vf', 'fps=30',
      // MediaRecorder audio can drift on long recordings; resample to keep sync.
      '-af', 'aresample=async=1',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      // 2 s keyframe interval so the in-app smart-cut trim can stream-copy
      // GOPs instead of re-encoding (x264 default ~8 s is too sparse).
      '-g', '60',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 8192) stderr = stderr.slice(-8192); // keep tail only
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);

    const fail = (message) => {
      const err = new Error(message);
      err.isFfmpeg = true;
      reject(err);
    };

    proc.on('error', (err) => {
      clearTimeout(timer);
      fail(`ffmpeg spawn failed: ${err.message}`);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return fail('ffmpeg timed out after 30 minutes (SIGKILL)');
      if (code === 0) return resolve();
      fail(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`);
    });
  });
}

// PUT a local file to Bunny Storage. Resolves { status, body }.
function putFileToBunny(filePath, size, creds, objectPath, contentType) {
  return new Promise((resolve, reject) => {
    const bunnyUrl = `https://${creds.host}/${creds.zone}/${objectPath}`;
    const proxyReq = https.request(
      bunnyUrl,
      {
        method: 'PUT',
        headers: {
          AccessKey: creds.key,
          'Content-Type': contentType,
          'Content-Length': size,
        },
      },
      (proxyRes) => {
        const chunks = [];
        proxyRes.on('data', (c) => chunks.push(c));
        proxyRes.on('end', () =>
          resolve({
            status: proxyRes.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    proxyReq.on('error', reject);
    const rs = fs.createReadStream(filePath);
    rs.on('error', (err) => {
      proxyReq.destroy(err);
      reject(err);
    });
    rs.pipe(proxyReq);
  });
}

async function handleConvertUpload(req, res, creds, name, folder) {
  // Express default timeouts would kill a long conversion mid-flight.
  req.setTimeout(CONVERT_REQ_TIMEOUT_MS);
  if (typeof res.setTimeout === 'function') res.setTimeout(CONVERT_REQ_TIMEOUT_MS);

  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `rbg-convert-${id}.in`);
  const outPath = path.join(os.tmpdir(), `rbg-convert-${id}.mp4`);
  const mp4Name = sanitizeName(name.replace(/\.[^.]*$/, '') + '.mp4');
  const objectPath = `${folder}${mp4Name}`;

  try {
    // 1) Stream request body to a temp file (never buffered in RAM)
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(inPath);
      ws.on('finish', resolve);
      ws.on('error', reject);
      req.on('error', reject);
      req.on('aborted', () => {
        ws.destroy();
        reject(new Error('Request aborted during upload'));
      });
      req.pipe(ws);
    });

    const inSize = (await fsp.stat(inPath)).size;
    console.log(`[convert] start name=${name} size=${inSize}`);
    const t0 = Date.now();

    // 2) Transcode
    await runFfmpeg(inPath, outPath);
    console.log(`[convert] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // 3) Stream the MP4 to Bunny Storage
    const outSize = (await fsp.stat(outPath)).size;
    const result = await putFileToBunny(outPath, outSize, creds, objectPath, 'video/mp4');
    if (result.status >= 200 && result.status < 300) {
      res.json({
        ok: true,
        url: `${creds.pull}/${objectPath}`,
        storagePath: `/${creds.zone}/${objectPath}`,
        size: outSize,
        converted: true,
      });
    } else {
      console.warn(`[convert:upload-fail] ${result.status} ${result.body.slice(0, 200)}`);
      res.status(result.status || 502).json({
        ok: false,
        error: `Bunny upload failed: ${result.status}`,
        details: result.body.slice(0, 500),
      });
    }
  } catch (err) {
    console.error('[convert:error]', err.message);
    if (!res.headersSent) {
      if (err.isFfmpeg) {
        res.status(500).json({ ok: false, error: `Konverze selhala: ${err.message}`.slice(0, 400) });
      } else {
        res.status(502).json({ ok: false, error: err.message });
      }
    }
  } finally {
    // 4) Always clean up temp files, success or failure
    await fsp.rm(inPath, { force: true }).catch(() => {});
    await fsp.rm(outPath, { force: true }).catch(() => {});
  }
}

// ────── Upload (streaming PUT to Bunny) ──────
app.post('/upload', (req, res) => {
  if (!checkSecret(req, res)) return;
  const creds = readBunnyCreds(req, res);
  if (!creds) return;

  const name = sanitizeName(req.query.name);
  const folder = sanitizeFolder(req.query.folder);
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Missing "name" query param' });
  }

  // Server-side WebM→MP4 conversion — skipped when the body is already MP4
  const wantsConvert = String(req.query.convert || '').toLowerCase() === 'mp4';
  const alreadyMp4 =
    /\.mp4$/i.test(name) ||
    String(req.headers['content-type'] || '').toLowerCase().startsWith('video/mp4');
  if (wantsConvert && !alreadyMp4) {
    return handleConvertUpload(req, res, creds, name, folder);
  }

  const objectPath = `${folder}${name}`;
  const bunnyUrl = `https://${creds.host}/${creds.zone}/${objectPath}`;
  const contentType = req.headers['content-type'] || 'application/octet-stream';
  const contentLength = req.headers['content-length'];

  console.log(
    `[upload] ${creds.zone}/${objectPath} (${contentLength ? `${contentLength} B` : 'streamed'}, ${contentType})`
  );

  const proxyReq = https.request(
    bunnyUrl,
    {
      method: 'PUT',
      headers: {
        AccessKey: creds.key,
        'Content-Type': contentType,
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
      },
    },
    (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        const status = proxyRes.statusCode || 0;
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 200 && status < 300) {
          res.json({
            ok: true,
            url: `${creds.pull}/${objectPath}`,
            storagePath: `/${creds.zone}/${objectPath}`,
            size: contentLength ? Number(contentLength) : undefined,
          });
        } else {
          console.warn(`[upload:fail] ${status} ${body.slice(0, 200)}`);
          res.status(status || 502).json({
            ok: false,
            error: `Bunny upload failed: ${status}`,
            details: body.slice(0, 500),
          });
        }
      });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('[upload:proxy-error]', err);
    if (!res.headersSent) res.status(502).json({ ok: false, error: err.message });
  });
  req.on('error', (err) => {
    console.error('[upload:req-error]', err);
    proxyReq.destroy(err);
  });
  req.on('aborted', () => {
    console.warn('[upload:aborted]');
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
});

// ────── Bunny Stream upload (create video, then streamed PUT) ──────
// Stream transcodes to adaptive-bitrate HLS itself — no ffmpeg needed here,
// WebM and MP4 alike are accepted as-is.
function readStreamCreds(req, res) {
  const library = String(req.headers['x-stream-library'] || '').trim();
  const key = String(req.headers['x-stream-key'] || '').trim();
  if (!/^\d+$/.test(library) || !key) {
    res.status(400).json({
      ok: false,
      error:
        'Missing Stream credentials. Required headers: x-stream-library (Library ID, číslo), x-stream-key (API key knihovny)',
    });
    return null;
  }
  return { library, key };
}

function streamApi(method, apiPath, key, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request(
      `https://video.bunnycdn.com${apiPath}`,
      {
        method,
        headers: {
          AccessKey: key,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
        },
      },
      (rs) => {
        const chunks = [];
        rs.on('data', (c) => chunks.push(c));
        rs.on('end', () =>
          resolve({
            status: rs.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

app.post('/upload-stream', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const creds = readStreamCreds(req, res);
  if (!creds) return;
  req.setTimeout(CONVERT_REQ_TIMEOUT_MS);
  if (typeof res.setTimeout === 'function') res.setTimeout(CONVERT_REQ_TIMEOUT_MS);

  // Title keeps diacritics — it is a human-readable label in the Stream
  // library, not a URL path.
  const title =
    String(req.query.name || 'recording').replace(/\.[^.]*$/, '').slice(0, 200) ||
    'recording';
  const collection = String(req.query.collection || '').trim();

  // 1) Create the video object (gets us the guid to upload into)
  let guid;
  try {
    const created = await streamApi(
      'POST',
      `/library/${creds.library}/videos`,
      creds.key,
      { title, ...(collection ? { collectionId: collection } : {}) }
    );
    if (created.status < 200 || created.status >= 300) {
      console.warn(`[stream:create-fail] ${created.status} ${created.body.slice(0, 200)}`);
      return res.status(created.status === 401 ? 401 : 502).json({
        ok: false,
        error:
          `Bunny Stream: vytvoření videa selhalo (${created.status}).` +
          (created.status === 401 ? ' Zkontroluj Library ID a API klíč.' : ''),
        details: created.body.slice(0, 300),
      });
    }
    guid = JSON.parse(created.body).guid;
    if (!guid) throw new Error('Bunny Stream nevrátil guid videa');
  } catch (err) {
    console.error('[stream:create-error]', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }

  console.log(`[stream] upload lib=${creds.library} guid=${guid} title="${title}"`);

  // 2) Stream the request body straight to the video upload endpoint
  const contentLength = req.headers['content-length'];

  // Byte/time accounting on the inbound body. Without it an aborted upload
  // logs nothing but "[stream:aborted]", which cannot distinguish our own
  // timeout from an edge/client one. With it the log line says how far the
  // body got and after how long — the two numbers that name the culprit.
  const t0 = Date.now();
  let received = 0;
  req.on('data', (c) => {
    received += c.length;
  });
  const progressLine = () => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const mbps = received > 0 ? ((received * 8) / (Date.now() - t0) / 1000).toFixed(1) : '0';
    return (
      `guid=${guid} received=${received}` +
      (contentLength ? `/${contentLength}` : '') +
      ` after=${secs}s (~${mbps} Mbit/s)`
    );
  };
  const uploadReq = https.request(
    `https://video.bunnycdn.com/library/${creds.library}/videos/${guid}`,
    {
      method: 'PUT',
      headers: {
        AccessKey: creds.key,
        'Content-Type': 'application/octet-stream',
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
      },
    },
    (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const status = upRes.statusCode || 0;
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 200 && status < 300) {
          res.json({
            ok: true,
            guid,
            libraryId: creds.library,
            // Shareable player page (adaptive bitrate, works everywhere)
            url: `https://iframe.mediadelivery.net/play/${creds.library}/${guid}`,
            embedUrl: `https://iframe.mediadelivery.net/embed/${creds.library}/${guid}`,
          });
        } else {
          console.warn(`[stream:upload-fail] ${status} ${body.slice(0, 200)}`);
          // Don't leave an empty video object behind
          streamApi('DELETE', `/library/${creds.library}/videos/${guid}`, creds.key).catch(
            () => {}
          );
          res.status(status || 502).json({
            ok: false,
            error: `Bunny Stream upload selhal: ${status}`,
            details: body.slice(0, 300),
          });
        }
      });
    }
  );

  uploadReq.on('error', (err) => {
    console.error(`[stream:proxy-error] ${progressLine()}`, err);
    streamApi('DELETE', `/library/${creds.library}/videos/${guid}`, creds.key).catch(() => {});
    if (!res.headersSent) res.status(502).json({ ok: false, error: err.message });
  });
  req.on('error', (err) => {
    console.error(`[stream:req-error] ${err.code || err.message} ${progressLine()}`);
    uploadReq.destroy(err);
  });
  req.on('aborted', () => {
    console.warn(`[stream:aborted] ${progressLine()}`);
    uploadReq.destroy();
    streamApi('DELETE', `/library/${creds.library}/videos/${guid}`, creds.key).catch(() => {});
  });
  req.on('end', () => {
    console.log(`[stream:body-complete] ${progressLine()}`);
  });

  req.pipe(uploadReq);
});

// ────── Bunny Stream encode status ──────
// Bunny status codes: 0 Created, 1 Uploaded, 2 Processing, 3 Transcoding,
// 4 Finished, 5 Error, 6 UploadFailed. We collapse them to ready/processing/error.
app.get('/stream-status', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const creds = readStreamCreds(req, res);
  if (!creds) return;
  const guid = String(req.query.guid || '').trim();
  if (!guid) return res.status(400).json({ ok: false, error: 'Missing "guid"' });

  try {
    const r = await streamApi(
      'GET',
      `/library/${creds.library}/videos/${guid}`,
      creds.key
    );
    if (r.status < 200 || r.status >= 300) {
      return res.status(r.status === 404 ? 404 : 502).json({
        ok: false,
        error: `Bunny Stream status ${r.status}`,
      });
    }
    const v = JSON.parse(r.body);
    const code = Number(v.status);
    const state =
      code >= 4 && code !== 5 && code !== 6
        ? 'ready'
        : code === 5 || code === 6
        ? 'error'
        : 'processing';
    res.json({
      ok: true,
      state,
      code,
      encodeProgress: Number(v.encodeProgress) || 0,
      title: v.title,
    });
  } catch (err) {
    console.error('[stream:status-error]', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ────── Delete (per-user Bunny creds) ──────
app.delete('/file', (req, res) => {
  if (!checkSecret(req, res)) return;
  const creds = readBunnyCreds(req, res);
  if (!creds) return;

  const folder = sanitizeFolder(req.query.folder);
  const name = sanitizeName(req.query.name);
  if (!name) {
    return res.status(400).json({ ok: false, error: 'Missing "name" query param' });
  }
  const objectPath = `${folder}${name}`;
  const bunnyUrl = `https://${creds.host}/${creds.zone}/${objectPath}`;

  const r = https.request(
    bunnyUrl,
    { method: 'DELETE', headers: { AccessKey: creds.key } },
    (proxyRes) => {
      const status = proxyRes.statusCode || 0;
      let body = '';
      proxyRes.on('data', (c) => (body += c));
      proxyRes.on('end', () => {
        if (status >= 200 && status < 300) {
          res.json({ ok: true });
        } else {
          res.status(status || 502).json({ ok: false, error: body.slice(0, 200) });
        }
      });
    }
  );
  r.on('error', (err) => res.status(502).json({ ok: false, error: err.message }));
  r.end();
});

const server = app.listen(Number(PORT), () => {
  console.log(
    `[records-by-grevo-proxy] listening on :${PORT} (multi-tenant mode)`
  );
  // Printed so the effective body-upload budget can be read off the
  // container log — this is the setting large uploads live or die by.
  console.log(
    `[records-by-grevo-proxy] timeouts: requestTimeout=${server.requestTimeout}ms ` +
      `headersTimeout=${server.headersTimeout}ms keepAliveTimeout=${server.keepAliveTimeout}ms ` +
      `socketTimeout=${server.timeout}ms`
  );
});

// THE reason large uploads died with a bare "network error" in the browser.
//
// Node's `server.requestTimeout` (default 300 000 ms since Node 18) is a hard
// wall-clock cap on receiving an ENTIRE request — headers *and* body. It keeps
// counting while the body is actively streaming in, and when it expires Node
// answers 408 and destroys the socket mid-upload. The browser is still sending
// at that point, so XHR fires `error` with status 0 → "Síťová chyba".
//
// `req.setTimeout()` (used by the upload handlers below) does NOT help: that
// only sets the socket's *idle* timeout, a different mechanism. Reproduced
// locally on Node 22 — with requestTimeout in force a slow upload is killed
// whether or not req.setTimeout() was called, and survives once it is raised.
//
// 406 MB inside 300 s needs ~11.3 Mbit/s of sustained upstream, which is why
// this only ever bit long recordings. Give a body upload the same budget the
// conversion path already reserves for itself.
server.requestTimeout = CONVERT_REQ_TIMEOUT_MS; // 35 min for the whole body
server.headersTimeout = 60_000; // must stay below requestTimeout
server.keepAliveTimeout = 65_000;
server.timeout = 0; // no socket idle cap; routes set their own
