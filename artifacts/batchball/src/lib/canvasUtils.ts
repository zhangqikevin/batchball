export function toCanvas(img: HTMLImageElement, { scale = 1, maxDim = 4096 } = {}): HTMLCanvasElement {
  let w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  if (Math.max(w, h) > maxDim) { const k = maxDim / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, w, h);
  return c;
}

export function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number, scale = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d', { willReadFrequently: true })!.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

export function imageDataOf(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
}

export function enhanceCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const d = imageDataOf(canvas), p = d.data;
  let mn = 255, mx = 0;
  for (let i = 0; i < p.length; i += 4) { const g = p[i]*0.299 + p[i+1]*0.587 + p[i+2]*0.114; p[i] = g; if (g < mn) mn = g; if (g > mx) mx = g; }
  const r = Math.max(1, mx - mn);
  for (let i = 0; i < p.length; i += 4) { const v = (p[i] - mn) / r * 255; p[i] = p[i+1] = p[i+2] = v; }
  const c2 = document.createElement('canvas'); c2.width = canvas.width; c2.height = canvas.height;
  c2.getContext('2d', { willReadFrequently: true })!.putImageData(d, 0, 0); return c2;
}

export function threshCanvas(canvas: HTMLCanvasElement, t: number): HTMLCanvasElement {
  const d = imageDataOf(canvas), p = d.data;
  for (let i = 0; i < p.length; i += 4) { const g = p[i]*0.299 + p[i+1]*0.587 + p[i+2]*0.114, v = g > t ? 255 : 0; p[i] = p[i+1] = p[i+2] = v; }
  const c2 = document.createElement('canvas'); c2.width = canvas.width; c2.height = canvas.height;
  c2.getContext('2d', { willReadFrequently: true })!.putImageData(d, 0, 0); return c2;
}

export function regionTone(canvas: HTMLCanvasElement): { lum: number; sat: number } {
  const p = imageDataOf(canvas).data;
  let lum = 0, sat = 0, n = p.length / 4;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], g = p[i+1], b = p[i+2];
    lum += r*0.299 + g*0.587 + b*0.114;
    sat += Math.max(r,g,b) - Math.min(r,g,b);
  }
  return { lum: lum/n, sat: sat/n };
}

export function extractCert(text: string | null | undefined): string | null {
  if (!text) return null;
  const url = text.match(/cert[\/#:\s-]*(\d{7,10})/i);
  if (url) return url[1];
  const t = String(text).replace(/[\s-]/g, '');
  let cert: string | null = null;
  if (/^\d{7,10}$/.test(t)) cert = t;
  else { const embedded = t.match(/\d{8,9}/); cert = embedded ? embedded[0] : null; }
  if (cert && cert.startsWith('0')) return null;
  return cert;
}

export function proposeRegions(img: HTMLImageElement): Array<{x: number; y: number; w: number; h: number}> {
  const K = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = toCanvas(img, { scale: K });
  const w = c.width, h = c.height;
  const p = imageDataOf(c).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = p[i*4]*0.299 + p[i*4+1]*0.587 + p[i*4+2]*0.114;
  const score = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = Math.abs(gray[i+1] - gray[i-1]), gy = Math.abs(gray[i+w] - gray[i-w]);
    score[i] = Math.max(0, gx - gy);
  }
  const tmp = new Float32Array(w * h), sm = new Float32Array(w * h);
  const R1 = 10, R2 = 3;
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += score[y*w+x]; if (x >= 2*R1+1) s -= score[y*w+x-2*R1-1]; if (x >= R1) tmp[y*w+x-R1] = s / (2*R1+1); } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = 0; y < h; y++) { s += tmp[y*w+x]; if (y >= 2*R2+1) s -= tmp[(y-2*R2-1)*w+x]; if (y >= R2) sm[(y-R2)*w+x] = s / (2*R2+1); } }
  const TH = 18, seen = new Uint8Array(w * h);
  let boxes: Array<{x: number; y: number; w: number; h: number}> = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (sm[i] < TH || seen[i]) continue;
    let minx = x, maxx = x, miny = y, maxy = y, n = 0;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop()!; n++;
      const jy = (j / w) | 0, jx = j % w;
      if (jx < minx) minx = jx; if (jx > maxx) maxx = jx; if (jy < miny) miny = jy; if (jy > maxy) maxy = jy;
      for (const d of [-1, 1, -w, w, -w-1, -w+1, w-1, w+1]) {
        const q = j + d;
        if (q >= 0 && q < w * h && !seen[q] && sm[q] >= TH) { seen[q] = 1; st.push(q); }
      }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (bw >= 25 && bh >= 6 && bw > bh * 1.2 && n > bw * bh * 0.3 && bw < w * 0.5) boxes.push({ x: minx, y: miny, w: bw, h: bh });
  }
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const xGap = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      const yOv = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (xGap < 14 && yOv > 0.5 * Math.min(a.h, b.h)) {
        const nx = Math.min(a.x, b.x), ny = Math.min(a.y, b.y);
        boxes[i] = { x: nx, y: ny, w: Math.max(a.x+a.w, b.x+b.w) - nx, h: Math.max(a.y+a.h, b.y+b.h) - ny };
        boxes.splice(j, 1); merged = true; break outer;
      }
    }
  }
  boxes = boxes.filter(b => b.w >= 50 && b.h >= 12 && b.w > b.h * 1.2 && b.w / b.h <= 12 && b.h <= 110)
    .sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 48);
  return boxes.map(b => ({ x: b.x / K, y: b.y / K, w: b.w / K, h: b.h / K }));
}

export function proposeRedFrames(img: HTMLImageElement): { K: number; c: HTMLCanvasElement; boxes: Array<{x: number; y: number; w: number; h: number}> } {
  const K = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = toCanvas(img, { scale: K });
  const w = c.width, h = c.height;
  const p = imageDataOf(c).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = p[i*4], g = p[i*4+1], b = p[i*4+2];
    mask[i] = (r > 110 && r - g > 45 && r - b > 35) ? 1 : 0;
  }
  const seen = new Uint8Array(w * h);
  const boxes: Array<{x: number; y: number; w: number; h: number}> = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let minx=i%w, maxx=minx, miny=(i/w)|0, maxy=miny, n=0;
    const st=[i]; seen[i]=1;
    while (st.length) {
      const j=st.pop()!; n++;
      const jy=(j/w)|0, jx=j%w;
      if(jx<minx)minx=jx; if(jx>maxx)maxx=jx; if(jy<miny)miny=jy; if(jy>maxy)maxy=jy;
      for (const d of [-1,1,-w,w,-w-1,-w+1,w-1,w+1]) {
        const q=j+d;
        if (q>=0 && q<w*h && !seen[q] && mask[q]) { seen[q]=1; st.push(q); }
      }
    }
    const bw=maxx-minx+1, bh=maxy-miny+1, fill=n/(bw*bh);
    if (bw>=50 && bh>=14 && bw/bh>=2 && bw/bh<=8 && fill>0.05 && fill<0.75) boxes.push({x:minx,y:miny,w:bw,h:bh});
  }
  return { K, c, boxes };
}

export function filterRedFrames(img: HTMLImageElement): Array<{x: number; y: number; w: number; h: number}> {
  const { K, c, boxes } = proposeRedFrames(img);
  let frames = boxes.filter(f => {
    const inner = cropCanvas(c, f.x + f.w*0.12, f.y + f.h*0.15, f.w*0.76, f.h*0.7, 0.5);
    const tone = regionTone(inner);
    return tone.lum > 150 && tone.sat < 75;
  });
  if (frames.length >= 3) {
    const areas = frames.map(f=>f.w*f.h).sort((a,b)=>a-b);
    const median = areas[areas.length >> 1];
    frames = frames.filter(f => { const a=f.w*f.h; return a > median*0.6 && a < median*1.7; });
  }
  return frames.map(f => ({ x: f.x/K, y: f.y/K, w: f.w/K, h: f.h/K }));
}

export function proposeLabelBands(img: HTMLImageElement): Array<{x: number; y: number; w: number; h: number}> {
  const K = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = toCanvas(img, { scale: K });
  const w = c.width, h = c.height;
  const p = imageDataOf(c).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = p[i*4], g = p[i*4+1], b = p[i*4+2];
    const lum = r*0.299 + g*0.587 + b*0.114;
    const sat = Math.max(r,g,b) - Math.min(r,g,b);
    mask[i] = (lum > 140 && sat < 60) ? 1 : 0;
  }
  const G = 8, gw = Math.ceil(w/G), gh = Math.ceil(h/G);
  const grid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let n = 0, tot = 0;
    for (let y = gy*G; y < Math.min(h,(gy+1)*G); y++) for (let x = gx*G; x < Math.min(w,(gx+1)*G); x++) { tot++; n += mask[y*w+x]; }
    grid[gy*gw+gx] = n >= tot*0.6 ? 1 : 0;
  }
  const seen2 = new Uint8Array(gw * gh);
  const boxes: Array<{x: number; y: number; w: number; h: number}> = [];
  for (let i = 0; i < gw*gh; i++) {
    if (!grid[i] || seen2[i]) continue;
    let minx=i%gw, maxx=minx, miny=(i/gw)|0, maxy=miny, n=0;
    const st=[i]; seen2[i]=1;
    while (st.length) {
      const j = st.pop()!; n++;
      const jy=(j/gw)|0, jx=j%gw;
      if(jx<minx)minx=jx; if(jx>maxx)maxx=jx; if(jy<miny)miny=jy; if(jy>maxy)maxy=jy;
      for (const d of [-1,1,-gw,gw]) {
        const q=j+d; const qy=(q/gw)|0;
        if (q>=0 && q<gw*gh && !seen2[q] && grid[q] && Math.abs(qy-jy)<=1) { seen2[q]=1; st.push(q); }
      }
    }
    const bw=(maxx-minx+1)*G, bh=(maxy-miny+1)*G;
    if (bw >= 90 && bh >= 18 && bh <= 200 && bw/bh >= 1.8 && n >= (maxx-minx+1)*(maxy-miny+1)*0.5)
      boxes.push({ x: minx*G/K, y: miny*G/K, w: bw/K, h: bh/K });
  }
  return boxes.sort((a,b)=>b.w-a.w).slice(0, 30);
}
