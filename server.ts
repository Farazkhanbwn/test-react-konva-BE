import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import DxfParser from 'dxf-parser';
import { dxfToFloorPlan } from './dxfToFloorPlan';
import { isSparkixLayeredDxf } from './dxfLayerExport';
import { runFloorPlanPipeline } from './floorPlanPipeline';
import { savePlanSession, getPlanSession } from './planSessionStore';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));

const ALLOWED_EXT = ['.dxf'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname) || ''}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error(`Only DXF files are allowed. Got: ${ext || 'no extension'}`));
  },
});

const uploadJson = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.json') cb(null, true);
    else cb(new Error('Only .json files are allowed.'));
  },
});

function wantDebug(req: Request): boolean {
  const q = req.query.debug;
  return q === '1' || q === 'true' || q === 'yes';
}

function sendPipeline(
  res: Response,
  body: Record<string, unknown>,
  pipeline: ReturnType<typeof runFloorPlanPipeline>
): void {
  if (!pipeline.ok || !pipeline.plan || !pipeline.konva) {
    res.status(400).json({
      error: 'Invalid or empty floor plan',
      details: pipeline.errors,
      ...(wantDebug(res.req as Request) && pipeline.debugSteps ? { debug: { steps: pipeline.debugSteps } } : {}),
    });
    return;
  }
  const out: Record<string, unknown> = {
    ...body,
    plan: pipeline.plan,
    konva: pipeline.konva,
    warnings: pipeline.warnings,
  };
  if (wantDebug(res.req as Request) && pipeline.debugSteps) {
    out.debug = { steps: pipeline.debugSteps };
  }
  res.json(out);
}

/**
 * POST /upload — DXF → plan through same pipeline as JSON (Konva-safe).
 * ?debug=1 — step-by-step trace in response.debug.steps
 */
app.post('/upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form field "file" with a .dxf file.' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) {
    return res.status(400).json({ error: 'Only .dxf files are accepted.' });
  }

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(req.file.path, 'utf8');
  } catch {
    return res.status(500).json({ error: 'Failed to read uploaded file.' });
  }

  let dxfRaw: ReturnType<DxfParser['parseSync']>;
  try {
    dxfRaw = new DxfParser().parseSync(fileContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'DXF parse failed';
    return res.status(400).json({ error: 'Failed to parse DXF file.', detail: message });
  }

  const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const entities = (dxfRaw?.entities ?? []) as unknown[];
  const layerAware = isSparkixLayeredDxf(entities as never);

  const rawPlan = dxfToFloorPlan(dxfRaw, {
    projectName: process.env.PROJECT_NAME || baseName.replace(/[-_]+/g, ' ').trim() || 'Floor plan',
  });

  const debug = wantDebug(req);
  const pipeline = runFloorPlanPipeline(rawPlan, { debug });

  if (debug && pipeline.debugSteps) {
    const dxfSteps = [
      {
        step: 0,
        phase: 'parse_dxf',
        detail: `dxf-parser OK; ${entities.length} entities`,
      },
      {
        step: 0,
        phase: 'dxf_to_plan',
        detail: layerAware
          ? 'Sparkix layers (WALLS/DOORS/WINDOWS/LABELS/STAIRS) → structured plan'
          : 'Legacy: all LINE/LWPOLYLINE → walls (noisy for random DXF)',
      },
    ];
    pipeline.debugSteps = [...dxfSteps, ...pipeline.debugSteps.map((s, i) => ({ ...s, step: i + 1 + dxfSteps.length }))];
  }

  if (!pipeline.ok || !pipeline.plan) {
    return res.status(400).json({
      error: 'DXF converted but plan failed validation',
      details: pipeline.errors,
      parsed: dxfRaw,
    });
  }

  const out: Record<string, unknown> = {
    source: 'dxf',
    parsed: dxfRaw,
    plan: pipeline.plan,
    konva: pipeline.konva,
    warnings: pipeline.warnings,
  };
  if (debug && pipeline.debugSteps) {
    out.debug = { steps: pipeline.debugSteps };
  }
  res.json(out);
});

/** POST /plan — canonical JSON (source of truth). ?debug=1 for steps */
app.post('/plan', (req: Request, res: Response) => {
  const pipeline = runFloorPlanPipeline(req.body, { debug: wantDebug(req) });
  sendPipeline(res, { source: 'json' }, pipeline);
});

/** POST /plan/session */
app.post('/plan/session', (req: Request, res: Response) => {
  const pipeline = runFloorPlanPipeline(req.body, { debug: wantDebug(req) });
  if (!pipeline.ok || !pipeline.plan) {
    return res.status(400).json({
      error: 'Invalid floor plan JSON',
      details: pipeline.errors,
      ...(wantDebug(req) && pipeline.debugSteps ? { debug: { steps: pipeline.debugSteps } } : {}),
    });
  }
  const sessionId = savePlanSession(pipeline.plan);
  const out: Record<string, unknown> = {
    source: 'json',
    sessionId,
    plan: pipeline.plan,
    konva: pipeline.konva,
    warnings: pipeline.warnings,
    designerUrl: `/designer?planSession=${sessionId}`,
  };
  if (wantDebug(req) && pipeline.debugSteps) {
    out.debug = { steps: pipeline.debugSteps };
  }
  res.json(out);
});

app.get('/plan/session/:sessionId', (req: Request, res: Response) => {
  const plan = getPlanSession(req.params.sessionId);
  if (!plan) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  const pipeline = runFloorPlanPipeline(plan, { debug: false });
  res.json({
    source: 'json',
    plan: pipeline.plan ?? plan,
    konva: pipeline.konva,
  });
});

app.post('/upload/plan', uploadJson.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file. Use form field "file" with a .json floor plan.' });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON file' });
  }
  const pipeline = runFloorPlanPipeline(raw, { debug: wantDebug(req) });
  if (!pipeline.ok || !pipeline.plan) {
    return res.status(400).json({
      error: 'Invalid floor plan schema',
      details: pipeline.errors,
    });
  }
  const sessionId = savePlanSession(pipeline.plan);
  const out: Record<string, unknown> = {
    source: 'json',
    sessionId,
    plan: pipeline.plan,
    konva: pipeline.konva,
    warnings: pipeline.warnings,
    designerUrl: `/designer?planSession=${sessionId}`,
  };
  if (wantDebug(req) && pipeline.debugSteps) {
    out.debug = { steps: pipeline.debugSteps };
  }
  res.json(out);
});

/** GET /plan/schema — minimal field checklist for Konva */
app.get('/plan/schema', (_req: Request, res: Response) => {
  res.json({
    description: 'Floor plan root object',
    required: ['meta', 'rooms', 'walls', 'doors', 'windows', 'stairs', 'furniture'],
    meta: [
      'version',
      'unit',
      'defaultWallHeight',
      'defaultWallThickness',
      'defaultInnerWallThickness',
      'slabThickness',
      'floorLevel',
      'projectName',
    ],
    room: ['id', 'label', 'x', 'y', 'width', 'height', 'floor.color', 'floor.material'],
    wall: ['id', 'x1', 'y1', 'x2', 'y2', 'thickness', 'isOuter', 'wallHeight', 'wallThickness3d'],
    door: ['id', 'x', 'y', 'width', 'height', 'wallId', 'rotation', 'type', 'openDirection', 'swingAngle'],
    window: ['id', 'x1', 'y1', 'x2', 'y2', 'height', 'sillHeight', 'wallId'],
    stairs: ['id', 'x', 'y', 'width', 'height', 'direction'],
    api: {
      konvaBounds: 'Response includes konva.bounds + suggestedPixelsPerMeter for Stage sizing',
      debug: 'Add ?debug=1 to POST /plan or POST /upload for pipeline steps',
    },
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  console.log('  GET  /plan/schema     — field checklist');
  console.log('  POST /plan?debug=1    — JSON → plan + konva + debug.steps');
  console.log('  POST /upload?debug=1  — DXF → plan + konva + debug.steps');
  console.log('  POST /plan/session | GET /plan/session/:id | POST /upload/plan');
});
