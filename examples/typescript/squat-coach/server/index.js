import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const UPLOADS_DIR = path.join(ROOT, '.uploads');
const OUT_DIR = path.join(ROOT, '.generated');
const PIPELINE_DIR = path.join(ROOT, 'pipeline');
// Defaults to the venv the README tells you to create; override if yours lives elsewhere.
const PYTHON = process.env.SQUAT_COACH_PYTHON || path.join(PIPELINE_DIR, 'venv', 'bin', 'python');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const app = express();
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  // The bytes get handed to OpenCV, MediaPipe and ffmpeg, so don't accept
  // whatever arrives. This is a content-type check, not a real one — a
  // production version should probe the file (ffprobe) and bound duration
  // and resolution too.
  // Content-type alone is too strict — non-browser clients often send
  // application/octet-stream for a perfectly good mp4 — so accept either
  // signal. This is a cheap sanity check, not validation: a real version
  // should probe with ffprobe before handing bytes to the decoders.
  fileFilter: (_req, file, cb) => {
    const byType = file.mimetype?.startsWith('video/');
    const byExt = /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.originalname || '');
    if (!byType && !byExt) {
      return cb(new Error('Only video files are accepted'));
    }
    cb(null, true);
  },
});

// One job at a time. Pose extraction is CPU-bound and concurrent jobs just
// make each other slower; without this, a handful of uploads wedges the box.
let running = false;

app.use('/generated', express.static(OUT_DIR));

function run(cmd, args, tag, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: PIPELINE_DIR });
    const killer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${tag} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(`[${tag}] ${d}`);
    });
    proc.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(`${tag} exited ${code}: ${stderr.slice(-2000)}`));
      resolve({ stdout, stderr });
    });
  });
}

app.post('/api/process-video', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no video file in request (expected field "video")' });
  }
  if (running) {
    fs.unlink(req.file.path, () => {});
    return res.status(429).json({ error: 'Already processing a video — try again when it finishes.' });
  }
  running = true;
  const jobId = randomUUID().slice(0, 8);
  const uploadedPath = req.file.path;
  const rawCopy = path.join(OUT_DIR, `${jobId}_raw.mp4`);

  try {
    // Layer 2's audit pass needs the untouched footage, and the browser needs
    // to play it back, so keep a copy under the served directory.
    fs.copyFileSync(uploadedPath, rawCopy);

    const { stdout } = await run(PYTHON, [
      path.join(PIPELINE_DIR, 'pipeline.py'),
      '--video', uploadedPath,
      '--name', jobId,
      '--out-dir', OUT_DIR,
    ], `layer1 ${jobId}`);

    const layer1 = JSON.parse(stdout.trim().split('\n').pop());
    const overlayPath = layer1.overlay_video_path;

    let coaching = null;
    let coachingError = null;
    if (process.env.GEMINI_API_KEY) {
      const finalPath = path.join(OUT_DIR, `${jobId}_coaching.json`);
      try {
        await run(PYTHON, [
          path.join(PIPELINE_DIR, 'layer2_twopass.py'),
          '--raw-video', rawCopy,
          '--overlay-video', overlayPath,
          '--scene-state', layer1.scene_state_path,
          '--out', finalPath,
        ], `layer2 ${jobId}`);
        coaching = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
      } catch (err) {
        // Layer 2 is additive — if it fails, a session driven by Layer 1's
        // measurements alone is still usable, so don't fail the whole request.
        coachingError = err.message;
        console.error(`[layer2 ${jobId}] failed, continuing without it:`, err.message);
      }
    } else {
      coachingError = 'GEMINI_API_KEY not set — skipped visual analysis (see .env.example)';
    }

    res.json({
      jobId,
      sceneState: layer1.scene_state,
      overlayVideoUrl: `/generated/${path.basename(overlayPath)}`,
      rawVideoUrl: `/generated/${path.basename(rawCopy)}`,
      coaching,
      coachingError,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    running = false;
    fs.unlink(uploadedPath, () => {});
  }
});

// Multer surfaces rejections (bad type, too large) as thrown errors; without
// this they render as an HTML 500 the frontend can't read.
app.use('/api', (err, _req, res, _next) => {
  const tooBig = err?.code === 'LIMIT_FILE_SIZE';
  res.status(tooBig ? 413 : 400).json({
    error: tooBig ? 'That video is over the 200MB limit.' : err?.message || 'Bad upload',
  });
});

const PORT = process.env.SQUAT_COACH_PORT || 7861;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`squat-coach pipeline backend on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set — visual analysis will be skipped.');
  }
});
