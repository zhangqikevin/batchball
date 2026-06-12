const API = 'https://alt-platform-server.production.internal.onlyalt.com/graphql/X';

const INITIAL_CERT_QUERY = `query InitialCert($certNumber: String!) { cert(certNumber: $certNumber) { certNumber gradeNumber gradingCompany asset { id } } }`;
const DETAIL_QUERY = `query Detail($id: ID!, $tsf: TimeSeriesFilter!) {
  asset(id: $id) { id name altValueInfo(tsFilter: $tsf) { currentAltValue } cardPops { gradingCompany gradeNumber count } }
}`;

async function gql(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json() as { errors?: Array<{message: string}>; data: unknown };
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, tries = 4, label = '', onLog?: (msg: string) => void): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e as Error;
      if (i < tries - 1) {
        onLog?.(`⚠ ${label} 查询失败(${lastErr.message})，${Math.pow(2,i)}s 后重试 (${i+1}/${tries-1})`);
        await sleep(1000 * Math.pow(2, i));
      }
    }
  }
  throw lastErr;
}

export interface CertData {
  name: string;
  grade: string;
  alt: number | null;
  totalPop: number;
  popByCo: string;
}

export async function queryCert(no: string, onLog?: (msg: string) => void): Promise<CertData> {
  const tsfDates = {
    startDate: new Date(new Date().setFullYear(new Date().getFullYear() - 2)).toISOString().split('T')[0],
    endDate: new Date(new Date().setDate(new Date().getDate() + 1)).toISOString().split('T')[0],
  };
  const initial = await withRetry(() => gql(INITIAL_CERT_QUERY, { certNumber: no }), 4, no, onLog) as {
    cert?: { certNumber: string; gradeNumber: number; gradingCompany: string; asset?: { id: string } }
  };
  if (!initial?.cert?.asset?.id) throw new Error('CERT NOT FOUND');
  const cert = initial.cert;
  const tsf = { ...tsfDates, gradingCompany: cert.gradingCompany, gradeNumber: String(cert.gradeNumber) };
  const detail = await withRetry(() => gql(DETAIL_QUERY, { id: cert.asset!.id, tsf }), 4, no, onLog) as {
    asset?: {
      id: string; name?: string;
      altValueInfo?: { currentAltValue?: number };
      cardPops?: Array<{ gradingCompany: string; gradeNumber: number; count: number }>;
    }
  };
  const asset = detail.asset!;
  const pops = asset.cardPops || [];
  const totalPop = pops.reduce((a, p) => a + (p.count || 0), 0);
  const popByCo = Object.entries(
    pops.reduce((acc: Record<string, number>, p) => { acc[p.gradingCompany] = (acc[p.gradingCompany] || 0) + p.count; return acc; }, {})
  ).map(([co, n]) => `${co}:${n.toLocaleString()}`).join(' / ');
  return {
    name: asset.name || '—',
    grade: `${cert.gradingCompany} ${cert.gradeNumber}`,
    alt: asset.altValueInfo?.currentAltValue ?? null,
    totalPop,
    popByCo,
  };
}
