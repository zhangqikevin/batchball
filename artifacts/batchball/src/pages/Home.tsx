import { useRef, useState, useEffect, useCallback } from 'react';
import { readBarcodes } from 'zxing-wasm/full';
import { createWorker } from 'tesseract.js';
import {
  toCanvas, cropCanvas, imageDataOf, enhanceCanvas, threshCanvas,
  regionTone, extractCert, proposeRegions, filterRedFrames, proposeLabelBands,
} from '../lib/canvasUtils';
import { queryCert, type CertData } from '../lib/altApi';

const CHECKSUMMED = new Set(['Code128','Code93','EAN-13','EAN-8','UPC-A','UPC-E','QRCode','MicroQRCode','rMQRCode','DataMatrix','Aztec','PDF417','DataBar','DataBarExpanded','DataBarLimited']);

interface Hit {
  cert: string; format: string; x: number; y: number;
  via: 'full' | 'region' | 'native' | 'ocr' | 'frame'; weak: boolean;
}
interface DetectCtx {
  img: HTMLImageElement;
  base: HTMLCanvasElement;
  hits: Hit[];
  regions: Array<{x: number; y: number; w: number; h: number}>;
  undecoded: Array<{x: number; y: number; w: number; h: number}>;
  redFrames: Array<{x: number; y: number; w: number; h: number}>;
}

interface RowData {
  status: 'pending' | 'ok' | 'err';
  data?: CertData;
  error?: string;
}
interface SuspectEntry {
  id: number; url: string; guesses: string[]; label: string; inputVal: string;
}
interface MethodStatus { state: string; text: string; }

let suspectIdCounter = 0;
let ocrWorkerInstance: Awaited<ReturnType<typeof createWorker>> | null = null;

async function getOcr() {
  if (!ocrWorkerInstance) ocrWorkerInstance = await createWorker('eng');
  return ocrWorkerInstance;
}

async function zxingScan(canvas: HTMLCanvasElement, max = 64): Promise<Array<{cert: string; format: string; cx: number; cy: number}>> {
  try {
    const rs = await readBarcodes(imageDataOf(canvas), { tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: max });
    return rs.map(r => {
      const cert = extractCert(r.text);
      if (!cert) return null;
      const cx = r.position ? (r.position.topLeft.x + r.position.bottomRight.x) / 2 : 0;
      const cy = r.position ? (r.position.topLeft.y + r.position.bottomRight.y) / 2 : 0;
      return { cert, format: r.format, cx, cy };
    }).filter(Boolean) as Array<{cert: string; format: string; cx: number; cy: number}>;
  } catch { return []; }
}

export default function Home() {
  const [debug] = useState(() => new URLSearchParams(location.search).has('debug'));
  const [isMobile] = useState(() => matchMedia('(pointer: coarse)').matches);

  const imagesRef = useRef<HTMLImageElement[]>([]);
  const certsRef = useRef(new Map<string, Set<string>>());
  const manualCertsRef = useRef(new Set<string>());
  const detectingRef = useRef(false);
  const queryingRef = useRef(false);
  const rowsRef = useRef(new Map<string, RowData>());

  const [previews, setPreviews] = useState<string[]>([]);
  const [certsList, setCertsList] = useState<Array<[string, string[]]>>([]);
  const [detecting, setDetecting] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [showProgress, setShowProgress] = useState(false);
  const [foundSummary, setFoundSummary] = useState('');
  const [methods, setMethods] = useState<Record<string, MethodStatus>>({
    m0: { state: '', text: '待运行' },
    m1: { state: '', text: '待运行' },
    m2: { state: '', text: '待运行' },
    m3: { state: '', text: '待运行' },
    m4: { state: '', text: '待运行' },
  });
  const [statsHtml, setStatsHtml] = useState('');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [suspects, setSuspects] = useState<SuspectEntry[]>([]);
  const [rowsVersion, setRowsVersion] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((msg: string) => {
    setLogLines(l => [...l, msg]);
  }, []);

  const updateCertsList = useCallback(() => {
    setCertsList([...certsRef.current.entries()].map(([no, srcs]) => [no, [...srcs]]));
  }, []);

  const addCert = useCallback((no: string, source: string) => {
    if (!no) return;
    if (!certsRef.current.has(no)) certsRef.current.set(no, new Set());
    certsRef.current.get(no)!.add(source);
    updateCertsList();
  }, [updateCertsList]);

  const removeCert = useCallback((no: string) => {
    certsRef.current.delete(no);
    manualCertsRef.current.delete(no);
    updateCertsList();
  }, [updateCertsList]);

  const setMethod = useCallback((id: string, state: string, text: string) => {
    setMethods(prev => ({ ...prev, [id]: { state, text } }));
  }, []);

  const countBySource = useCallback((src: string) => {
    let n = 0;
    for (const s of certsRef.current.values()) if (s.has(src)) n++;
    return n;
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  function recordHit(ctx: DetectCtx, scan: Array<{cert: string; format: string; cx: number; cy: number}>, mapX: (v: number) => number, mapY: (v: number) => number, via: Hit['via']) {
    for (const r of scan) {
      const weak = !CHECKSUMMED.has(r.format);
      ctx.hits.push({ cert: r.cert, format: r.format, x: mapX(r.cx), y: mapY(r.cy), via, weak });
    }
  }

  function hitNear(ctx: DetectCtx, box: {x: number; y: number; w: number; h: number}, margin = 0.5) {
    const x0 = box.x - box.w * margin, x1 = box.x + box.w * (1 + margin);
    const y0 = box.y - box.h * margin, y1 = box.y + box.h * (1 + margin);
    return ctx.hits.some(h => h.x >= x0 && h.x <= x1 && h.y >= y0 && h.y <= y1);
  }

  function consolidate(ctxs: DetectCtx[], finalPass: boolean) {
    const tally = new Map<string, {count: number; strong: boolean; sources: Set<string>}>();
    for (const ctx of ctxs) for (const h of ctx.hits) {
      if (h.via === 'ocr' || h.via === 'frame') continue;
      if (!tally.has(h.cert)) tally.set(h.cert, { count: 0, strong: false, sources: new Set() });
      const t = tally.get(h.cert)!;
      t.count++;
      if (!h.weak || h.via === 'region') t.strong = true;
      t.sources.add(h.via === 'native' ? 'Native' : (h.via === 'region' ? '区域解码' : 'ZXing'));
    }
    for (const [cert, t] of tally) {
      if (t.strong || t.count >= 2) { for (const s of t.sources) addCert(cert, s); }
      else if (finalPass) appendLog(`ℹ 弱格式条码 ${cert} 仅低分辨率解出一次，未自动采信（防 ITF 误读），如确认无误请手动添加`);
    }
  }

  function addSuspect(canvas: HTMLCanvasElement, guesses: string[], label: string) {
    const url = canvas.toDataURL('image/jpeg', 0.7);
    const valid = guesses.filter(g => /^\d{8,9}$/.test(g));
    setSuspects(prev => [...prev, {
      id: ++suspectIdCounter, url, guesses: valid, label, inputVal: valid[0] || '',
    }]);
  }

  async function method0(ctxs: DetectCtx[]) {
    setMethod('m0', 'running', '定位红框…');
    let frameTotal = 0, okN = 0;
    try {
      for (const ctx of ctxs) {
        const frames = filterRedFrames(ctx.img);
        ctx.redFrames = frames;
        frameTotal += frames.length;
        let i = 0;
        for (const f of frames) {
          i++;
          setMethod('m0', 'running', `标签 ${i}/${frames.length}`);
          const rx = f.x + f.w*0.52, ry = f.y + f.h*0.52, rw = f.w*0.45, rh = f.h*0.42;
          const up = Math.max(3, Math.min(6, 130 / rh));
          const certCrop = cropCanvas(ctx.base, rx, ry, rw, rh, up);
          const worker = await getOcr();
          const readOne = async (v: HTMLCanvasElement) => {
            const { data } = await worker.recognize(v);
            return (data.words || []).map((w: {text: string}) => w.text.trim()).filter((t: string) => /^\d{8,9}$/.test(t) && !t.startsWith('0'))[0] || null;
          };
          let a = await readOne(enhanceCanvas(certCrop));
          let b = await readOne(threshCanvas(certCrop, 150));
          let ocrCert: string | null = (a && a === b) ? a : null;
          if (!ocrCert && (a || b)) {
            const tallyM = new Map<string, number>();
            for (const n of [a, b].filter(Boolean) as string[]) tallyM.set(n, 1);
            for (const t of [110, 170, 200]) {
              const n = await readOne(threshCanvas(certCrop, t));
              if (n) tallyM.set(n, (tallyM.get(n) || 0) + 1);
            }
            ocrCert = ([...tallyM.entries()].find(([, c2]) => c2 >= 2) || [null])[0] as string | null;
          }
          const bx = Math.max(0, f.x), by = f.y + f.h*0.45, bw = f.w*0.52, bh = f.h*0.55;
          const bup = Math.max(2.5, Math.min(6, 900 / bw));
          let barCert: string | null = null;
          for (const v of [cropCanvas(ctx.base,bx,by,bw,bh,bup), threshCanvas(cropCanvas(ctx.base,bx,by,bw,bh,bup),140)]) {
            const s = await zxingScan(v, 2);
            if (s.length) { barCert = s[0].cert; break; }
          }
          const accepted: Array<[string, string]> = [];
          if (ocrCert) accepted.push([ocrCert, '红框OCR']);
          if (barCert) {
            accepted.push([barCert, '红框条码']);
            if (ocrCert && barCert !== ocrCert) appendLog(`⚠ 红框 (${f.x|0},${f.y|0}) 条码 ${barCert} 与印刷号 ${ocrCert} 不一致，两者均列出请核对`);
          }
          if (accepted.length) {
            okN++;
            for (const [n, src] of accepted) {
              addCert(n, src);
              ctx.hits.push({ cert: n, format: 'frame', x: f.x + f.w*0.25, y: f.y + f.h*0.72, via: 'frame', weak: false });
              ctx.hits.push({ cert: n, format: 'frame', x: f.x + f.w*0.74, y: f.y + f.h*0.72, via: 'frame', weak: false });
            }
          } else {
            const preview = cropCanvas(ctx.base, f.x, f.y, f.w, f.h, Math.min(2.5, 1000 / f.w));
            addSuspect(preview, [a, b].filter(Boolean) as string[], `红框标签 (${Math.round(f.x)},${Math.round(f.y)})`);
          }
        }
      }
      setMethod('m0', 'done', `完成 · ${frameTotal} 个红框 · 确认 ${okN} 张`);
    } catch (e) {
      setMethod('m0', 'skipped', '失败(跳过): ' + (e as Error).message);
      appendLog('⚠ 红框定位失败: ' + (e as Error).message);
    }
  }

  async function method1(ctxs: DetectCtx[]) {
    setMethod('m1', 'running', '运行中');
    for (const ctx of ctxs) {
      const c1 = toCanvas(ctx.img, { maxDim: 2400 });
      const k1 = ctx.img.naturalWidth / c1.width;
      recordHit(ctx, await zxingScan(c1), v => v * k1, v => v * k1, 'full');
      recordHit(ctx, await zxingScan(enhanceCanvas(c1)), v => v * k1, v => v * k1, 'full');
    }
    consolidate(ctxs, false);
    setMethod('m1', 'done', `完成 · 识别 ${countBySource('ZXing')} 个`);
  }

  async function method2(ctxs: DetectCtx[]) {
    if (!('BarcodeDetector' in window)) {
      setMethod('m2', 'skipped', '浏览器不支持(跳过)');
      appendLog('ℹ 当前浏览器无 BarcodeDetector，由其余 3 种方式保证覆盖');
      return;
    }
    setMethod('m2', 'running', '运行中');
    try {
      const detector = new (window as unknown as {BarcodeDetector: new () => {detect: (img: HTMLCanvasElement) => Promise<Array<{rawValue: string; boundingBox: {x: number; y: number; width: number; height: number}}>>}}).BarcodeDetector();
      for (const ctx of ctxs) {
        const c1 = toCanvas(ctx.img, { maxDim: 2400 });
        const k1 = ctx.img.naturalWidth / c1.width;
        for (const cv of [c1, enhanceCanvas(c1)]) {
          const dets = await detector.detect(cv).catch(() => [] as Array<{rawValue: string; boundingBox: {x: number; y: number; width: number; height: number}}>);
          for (const d of dets) {
            const cert = extractCert(d.rawValue);
            if (cert) ctx.hits.push({ cert, format: 'Native', x: (d.boundingBox.x + d.boundingBox.width/2) * k1, y: (d.boundingBox.y + d.boundingBox.height/2) * k1, via: 'native', weak: false });
          }
        }
      }
      consolidate(ctxs, false);
      setMethod('m2', 'done', `完成 · 识别 ${countBySource('Native')} 个`);
    } catch { setMethod('m2', 'skipped', '不可用(跳过)'); }
  }

  async function decodeRegion(ctx: DetectCtx, box: {x: number; y: number; w: number; h: number}, depth = 0): Promise<boolean> {
    const mx = Math.max(box.h * 1.5, box.w * 0.15), my = box.h * 1.2;
    const x = Math.max(0, box.x - mx), y = Math.max(0, box.y - my);
    const w = Math.min(ctx.base.width - x, box.w + 2*mx), h = Math.min(ctx.base.height - y, box.h + 2*my);
    if (w < 30 || h < 12) return false;
    let up = Math.max(1, Math.min(6, 1100 / w));
    if (up < 2.5 && w <= 1700) up = 2.5;
    up = Math.min(up, 4400 / w);
    const cell = cropCanvas(ctx.base, x, y, w, h, up);
    const variants = [cell, threshCanvas(cell, 120), threshCanvas(cell, 160), threshCanvas(cell, 80)];
    for (const v of variants) {
      const scan = await zxingScan(v, 4);
      if (scan.length) { recordHit(ctx, scan, cx => x + cx/up, cy => y + cy/up, 'region'); return true; }
    }
    if (depth < 2 && box.w > 380) {
      let any = false;
      for (const fx of [0, 0.275, 0.55]) {
        const sub = { x: box.x + box.w * fx, y: box.y, w: box.w * 0.45, h: box.h };
        if (await decodeRegion(ctx, sub, depth + 1)) any = true;
      }
      return any;
    }
    return false;
  }

  async function method3(ctxs: DetectCtx[]) {
    setMethod('m3', 'running', '定位条码区域…');
    let totalRegions = 0;
    for (const ctx of ctxs) {
      ctx.regions = proposeRegions(ctx.img);
      totalRegions += ctx.regions.length;
    }
    let done = 0;
    for (const ctx of ctxs) {
      for (const box of ctx.regions) {
        done++;
        setMethod('m3', 'running', `解码区域 ${done}/${totalRegions}`);
        if (hitNear(ctx, box)) continue;
        const ok = await decodeRegion(ctx, box);
        if (!ok) ctx.undecoded.push(box);
        consolidate(ctxs, false);
      }
    }
    consolidate(ctxs, false);
    setMethod('m3', 'done', `完成 · ${totalRegions} 区域 · 识别 ${countBySource('区域解码')} 个`);
  }

  async function method4(ctxs: DetectCtx[]) {
    setMethod('m4', 'running', '准备 OCR…(首次需下载语言包)');
    let suspects4 = 0;
    try {
      const worker = await getOcr();
      for (const ctx of ctxs) {
        const bands = proposeLabelBands(ctx.img);
        for (const b of ctx.undecoded) {
          const dup = bands.some(bd => {
            const xOv = Math.min(bd.x+bd.w, b.x+b.w) - Math.max(bd.x, b.x);
            const yOv = Math.min(bd.y+bd.h, b.y+b.h) - Math.max(bd.y, b.y);
            return xOv > 0 && yOv > 0.5 * Math.min(bd.h, b.h);
          });
          if (!dup) bands.push({ ...b });
        }
        const top = bands.slice(0, 32);
        let i = 0;
        for (const band of top) {
          i++;
          setMethod('m4', 'running', `OCR 区域 ${i}/${top.length}`);
          if (band.w < 600 && hitNear(ctx, band, 0.25)) continue;
          const mx = Math.min(400, Math.max(band.w * 0.15, band.h * 1.5)), my = band.h * 0.4;
          const x = Math.max(0, band.x - mx), y = Math.max(0, band.y - my);
          const w = Math.min(ctx.base.width - x, band.w + 2*mx), h = Math.min(ctx.base.height - y, band.h + 2*my);
          const up = Math.max(2.6, Math.min(4.5, 560 / h));
          const segW = Math.min(w, 1500), step = segW * 0.85;
          const byVariant = [new Set<string>(), new Set<string>(), new Set<string>(), new Set<string>(), new Set<string>()];
          const partials = new Set<string>();
          let labelTextSeen = false;
          for (let sx = x; sx < x + w; sx += step) {
            const sw = Math.min(segW, x + w - sx);
            if (sw < 120) break;
            const crop = cropCanvas(ctx.base, sx, y, sw, h, up);
            const variants = [enhanceCanvas(crop), threshCanvas(crop, 110), threshCanvas(crop, 140), threshCanvas(crop, 170), threshCanvas(crop, 200)];
            for (let vi = 0; vi < variants.length; vi++) {
              const { data } = await worker.recognize(variants[vi]);
              if (/\b(19|20)\d{2}\b|PSA|CGC|BGS|GEM\s?M|MINT|GRADE/i.test(data.text)) labelTextSeen = true;
              for (const raw of (data.words || []).map((w: {text: string}) => w.text.trim())) {
                if (/^\d{8,9}$/.test(raw) && !raw.startsWith('0')) byVariant[vi].add(raw);
                else { const d2 = raw.replace(/\D/g, ''); if (d2.length >= 5 && d2.length <= 9 && /\d{5,}/.test(raw)) partials.add(d2); }
              }
            }
            if (sw >= x + w - sx) break;
          }
          const tallyM = new Map<string, number>();
          for (const s of byVariant) for (const n of s) tallyM.set(n, (tallyM.get(n) || 0) + 1);
          const agreed = [...tallyM.entries()].filter(([, c]) => c >= 2).map(([n]) => n);
          const single = [...tallyM.entries()].filter(([, c]) => c === 1).map(([n]) => n);
          if (agreed.length) {
            for (const n of agreed) {
              addCert(n, 'OCR');
              ctx.hits.push({ cert: n, format: 'OCR', x: band.x + band.w/2, y: band.y + band.h/2, via: 'ocr', weak: false });
            }
          } else {
            const toneBox = cropCanvas(ctx.base, band.x, band.y, band.w, band.h, Math.min(1, 600 / band.w));
            const tone = regionTone(toneBox);
            const hints = [...new Set([...single, ...partials])].slice(0, 4);
            if (labelTextSeen && tone.lum > 130 && tone.sat < 70) {
              const preview = cropCanvas(ctx.base, x, y, w, h, Math.min(2, 1200 / w));
              addSuspect(preview, hints, `区域 (${Math.round(band.x)},${Math.round(band.y)})`);
              suspects4++;
            }
          }
        }
      }
      setMethod('m4', 'done', `完成 · 识别 ${countBySource('OCR')} 个 · 待核对 ${suspects4} 处`);
    } catch (e) {
      setMethod('m4', 'skipped', 'OCR 不可用(跳过)');
      appendLog('⚠ OCR 失败: ' + (e as Error).message);
    }
  }

  const runDetection = useCallback(async () => {
    if (detectingRef.current || !imagesRef.current.length) return;
    detectingRef.current = true;
    setDetecting(true);
    setSuspects([]);
    setFoundSummary('');
    setShowProgress(true);
    setProgressText('正在识别卡牌…');

    const progIv = setInterval(() => {
      const size = certsRef.current.size;
      setProgressText(size ? `正在识别卡牌…已找到 ${size} 张` : '正在识别卡牌…');
    }, 400);

    certsRef.current.clear();
    for (const m of manualCertsRef.current) addCert(m, '手动');
    updateCertsList();

    const t0 = performance.now();
    appendLog(`开始识别 ${imagesRef.current.length} 张图片...`);

    const ctxs: DetectCtx[] = imagesRef.current.map(img => ({
      img, base: toCanvas(img), hits: [], regions: [], undecoded: [], redFrames: [],
    }));

    await method0(ctxs);
    await method1(ctxs);
    await method2(ctxs);
    await method3(ctxs);
    consolidate(ctxs, true);
    await method4(ctxs);

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const frameN = ctxs.reduce((a, c) => a + (c.redFrames?.length || 0), 0);
    const regionN = ctxs.reduce((a, c) => a + c.regions.length, 0);
    const multi = [...certsRef.current.entries()].filter(([, s]) => s.size >= 2).length;

    clearInterval(progIv);
    setShowProgress(false);
    setStatsHtml(`红框标签 <b>${frameN}</b> 个 · 候选条码区域 <b>${regionN}</b> 个 · 确认证书号 <b>${certsRef.current.size}</b> 个（${multi} 个被 ≥2 种方式交叉确认）· 耗时 ${secs}s`);
    appendLog(`✔ 识别完成：${certsRef.current.size} 个证书号，耗时 ${secs}s`);

    setSuspects(prev => {
      const suspectN = prev.length;
      setFoundSummary(`识别到 ${certsRef.current.size} 张卡牌` + (suspectN ? `，另有 ${suspectN} 张需要核对（见下方）` : ''));
      return prev;
    });

    detectingRef.current = false;
    setDetecting(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addCert, appendLog, updateCertsList, countBySource]);

  async function addFiles(files: File[]) {
    const imgs = files.filter(f => f && f.type.startsWith('image'));
    if (!imgs.length) return;
    for (const f of imgs) {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise<void>((ok, no) => { img.onload = ok as () => void; img.onerror = no; img.src = url; });
      imagesRef.current.push(img);
      setPreviews(prev => [...prev, url]);
    }
    runDetection();
  }

  function clearAll() {
    imagesRef.current = [];
    certsRef.current.clear();
    manualCertsRef.current.clear();
    rowsRef.current.clear();
    setPreviews([]);
    setCertsList([]);
    setLogLines([]);
    setStatsHtml('');
    setSuspects([]);
    setFoundSummary('');
    setShowProgress(false);
    setShowResults(false);
    setRowsVersion(0);
    setMethods({ m0: { state: '', text: '待运行' }, m1: { state: '', text: '待运行' }, m2: { state: '', text: '待运行' }, m3: { state: '', text: '待运行' }, m4: { state: '', text: '待运行' } });
  }

  async function runOne(no: string, idx: number) {
    rowsRef.current.set(no, { status: 'pending' });
    setRowsVersion(v => v + 1);
    try {
      const data = await queryCert(no, appendLog);
      rowsRef.current.set(no, { status: 'ok', data });
      appendLog(`✔ ${no} → ${data.name} | $${Math.round(data.alt ?? 0)} | POP ${data.totalPop}`);
    } catch (e) {
      const err = (e as Error).message;
      rowsRef.current.set(no, { status: 'err', error: err === 'CERT NOT FOUND' ? '未找到该证书' : err });
      appendLog(`✕ ${no} 最终失败: ${err}`);
    }
    setRowsVersion(v => v + 1);
  }

  async function handleQuery() {
    if (queryingRef.current || !certsRef.current.size) return;
    queryingRef.current = true;
    setQuerying(true);
    rowsRef.current.clear();
    setShowResults(true);
    setRowsVersion(v => v + 1);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    const list = [...certsRef.current.keys()];
    let cursor = 0;
    await Promise.all([0, 1].map(async () => {
      while (cursor < list.length) { const i = cursor++; await runOne(list[i], i + 1); }
    }));
    queryingRef.current = false;
    setQuerying(false);
  }

  function exportCsv() {
    const lines: string[][] = [['Cert No', 'Name', 'Grade', 'Alt Value', 'Total POP', 'POP Breakdown', 'Status']];
    for (const [no, r] of rowsRef.current) {
      lines.push([no, r.data?.name ?? '', r.data?.grade ?? '', r.data?.alt != null ? String(Math.round(r.data.alt)) : '', String(r.data?.totalPop ?? ''), r.data?.popByCo ?? '', r.status]);
    }
    const csv = lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'pokemon-card-prices.csv'; a.click();
  }

  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const fs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image')).map(i => i.getAsFile()).filter(Boolean) as File[];
      if (fs.length) addFiles(fs);
    };
    document.addEventListener('paste', handler);
    return () => document.removeEventListener('paste', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPrices = (() => {
    let sum = 0, ok = 0;
    for (const r of rowsRef.current.values()) if (r.status === 'ok' && r.data?.alt != null) { sum += r.data.alt; ok++; }
    return { sum: Math.round(sum), ok };
  })();

  const rows = [...certsRef.current.keys()].map((no, i) => ({ no, idx: i + 1, row: rowsRef.current.get(no) }));

  return (
    <div className="container">
      {zoomSrc && (
        <div className="zoom-modal" onClick={() => setZoomSrc(null)}>
          <img src={zoomSrc} alt="放大" />
        </div>
      )}

      <h1>宝可梦卡牌价格汇总工具</h1>
      <div className="sub">上传评级卡照片，自动识别每张卡并查询 Alt 价格 / 总 POP / 名称</div>

      {/* Step 1: Upload */}
      <div className="panel">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>1. 上传图片（可多张 / 可粘贴）</h2>
          <button className="btn secondary small" onClick={clearAll}>清空重来</button>
        </div>
        <div
          id="dropZone"
          className={dragOver ? 'dragover' : ''}
          style={{ marginTop: 12 }}
          onClick={() => document.getElementById('fileInput')?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles([...e.dataTransfer.files]); }}
        >
          <strong>{isMobile ? '点此拍照或从相册选择' : '点击选择图片'}</strong>
          <span id="dropHint">{isMobile ? '一张照片可包含多张卡牌' : '可拖拽或粘贴，一张照片可包含多张卡牌'}</span>
        </div>
        <input
          type="file" id="fileInput" accept="image/*" multiple
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files) addFiles([...e.target.files]); e.target.value = ''; }}
        />
        {previews.length > 0 && (
          <div className="previews">
            {previews.map((url, i) => <img key={i} src={url} alt={`preview-${i}`} />)}
          </div>
        )}
      </div>

      {/* Step 2: Detect */}
      <div className="panel">
        <h2>2. 识别卡牌</h2>

        {debug && (
          <div>
            <div className="methods">
              {(['m0','m1','m2','m3','m4'] as const).map(id => (
                <div key={id} className={`method ${methods[id].state}`}>
                  <div className="name">{
                    id === 'm0' ? '方式⓪ PSA 红框标签定位\n(右下角号码 + 左下角条码互验)' :
                    id === 'm1' ? '方式① ZXing 全图多尺度扫描' :
                    id === 'm2' ? '方式② 浏览器原生 BarcodeDetector' :
                    id === 'm3' ? '方式③ 条码区域定位 + 高倍解码\n(梯度纹理检测/失败自动切分)' :
                    '方式④ 标签 OCR · 5 变体投票\n(≥2 票一致才采信，防误读)'
                  }</div>
                  <div className="stat">{methods[id].text}</div>
                </div>
              ))}
            </div>
            {statsHtml && <div className="stats" dangerouslySetInnerHTML={{ __html: statsHtml }} />}
            {logLines.length > 0 && (
              <div className="log-area" ref={logRef}>{logLines.join('\n')}</div>
            )}
          </div>
        )}

        {showProgress && (
          <div className="progress-bar">
            <div className="spinner" />
            <div>{progressText}</div>
          </div>
        )}
        {foundSummary && <div className="found-summary">{foundSummary}</div>}

        <div className="chips">
          {certsList.length === 0 ? (
            <span style={{ color: '#666', fontSize: 12 }}>还没有卡牌 — 请先上传图片</span>
          ) : certsList.map(([no, srcs]) => (
            <span key={no} className="chip" title={srcs.join('+')}>
              {no}
              {debug && <span className="src">[{srcs.join('+')}]</span>}
              <button onClick={() => removeCert(no)} title="移除">✕</button>
            </span>
          ))}
        </div>

        {suspects.length > 0 && (
          <div>
            <h2 style={{ marginTop: 16 }}>需要核对的卡牌</h2>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>以下卡牌没能自动确认号码，请对照小图输入标签上的证书号。</div>
            <div className="suspects">
              {suspects.map(s => (
                <div key={s.id} className="suspect">
                  <img src={s.url} alt="suspect" onClick={() => setZoomSrc(s.url)} title="点击放大" />
                  <div className="info">
                    {debug && <>{s.label}<br /></>}
                    {s.guesses.length > 0
                      ? `可能是 ${s.guesses.join(' 或 ')}，请对照小图核对`
                      : '没有读到这张卡的证书号。如果是老版 CGC 卡，号码印在卡砖背面，请翻面查看后输入'}
                  </div>
                  <input
                    inputMode="numeric"
                    placeholder="输入证书号"
                    defaultValue={s.guesses[0] || ''}
                    id={`suspect-input-${s.id}`}
                  />
                  <button className="btn small" onClick={() => {
                    const v = (document.getElementById(`suspect-input-${s.id}`) as HTMLInputElement)?.value.trim();
                    if (!/^\d{5,12}$/.test(v)) { alert('请输入纯数字证书号'); return; }
                    addCert(v, '人工确认'); manualCertsRef.current.add(v);
                    setSuspects(prev => prev.filter(x => x.id !== s.id));
                  }}>采用</button>
                  <button className="btn secondary small" onClick={() => setSuspects(prev => prev.filter(x => x.id !== s.id))}>忽略</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="addrow" style={{ marginTop: 12 }}>
          <input
            inputMode="numeric"
            placeholder="手动补充证书号..."
            value={manualInput}
            onChange={e => setManualInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') {
              const v = manualInput.trim();
              if (!/^\d{5,12}$/.test(v)) { alert('请输入纯数字证书号'); return; }
              addCert(v, '手动'); manualCertsRef.current.add(v); setManualInput('');
            }}}
          />
          <button className="btn secondary" onClick={() => {
            const v = manualInput.trim();
            if (!/^\d{5,12}$/.test(v)) { alert('请输入纯数字证书号'); return; }
            addCert(v, '手动'); manualCertsRef.current.add(v); setManualInput('');
          }}>添加</button>
          <button
            id="queryBtn"
            className="btn"
            disabled={detecting || querying || certsList.length === 0}
            onClick={handleQuery}
          >查询价格 →</button>
        </div>
      </div>

      {/* Step 3: Results */}
      {showResults && (
        <div className="panel" ref={resultRef}>
          <div className="toolbar" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>3. 价格汇总列表</h2>
            <button className="btn secondary small" onClick={exportCsv}>导出 CSV</button>
          </div>
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr><th>#</th><th>Cert No</th><th>名称</th><th>评级</th><th>Alt 价格</th><th>总 POP</th><th>状态</th></tr>
            </thead>
            <tbody>
              {rows.map(({ no, idx, row }) => (
                <tr key={no}>
                  <td className="rowidx">{idx}</td>
                  <td className="mono" data-l="证书号">{no}</td>
                  <td data-l="名称">{row?.data?.name ?? '—'}</td>
                  <td data-l="评级">{row?.data ? <span className="grade-badge">{row.data.grade}</span> : '—'}</td>
                  <td className="price" data-l="Alt 价格">{row?.data?.alt != null ? '$' + Math.round(row.data.alt).toLocaleString() : '—'}</td>
                  <td title={row?.data?.popByCo || ''} data-l="总 POP">{row?.data ? row.data.totalPop.toLocaleString() : '—'}</td>
                  <td data-l="状态">
                    {!row ? <span className="status-pending">等待中…</span> :
                      row.status === 'ok' ? <span className="status-ok">✔ 成功</span> :
                      row.status === 'pending' ? <span className="status-pending">查询中…</span> :
                      <><span className="status-err">✕ {row.error}</span> <button className="btn secondary small" onClick={() => runOne(no, idx)}>重试</button></>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>合计 (成功 <span>{totalPrices.ok}</span> 张)</td>
                <td>${totalPrices.sum.toLocaleString()}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
