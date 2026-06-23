# 宝可梦评级卡价格查询 API 说明

可直接复用的 API 调用说明（可作为 prompt 粘贴到其他项目里实现）。

## 基本信息

- **接口地址**：`https://proxy.kevinzhang.fun/pokeprice`
- **请求方式**：`POST`
- **协议**：GraphQL（请求体为 `{ query, variables }` 的 JSON）
- **请求头**：
  ```
  Content-Type: application/json
  x-api-key: J_4tM1IBP304QF3y9eFqnfSpy7efTTGPg6MCncATHXc
  ```

## 查询流程（每张卡需要两次请求）

### 第 1 步：用证书号换 asset id

GraphQL query：

```graphql
query InitialCert($certNumber: String!) {
  cert(certNumber: $certNumber) {
    certNumber
    gradeNumber
    gradingCompany
    asset { id }
  }
}
```

variables：

```json
{ "certNumber": "<证书号，纯数字字符串>" }
```

- 返回里取 `cert.asset.id`、`cert.gradingCompany`、`cert.gradeNumber`。
- 若 `cert.asset.id` 不存在 → 视为「未找到该证书」。

### 第 2 步：用 asset id 查价格与 POP

GraphQL query：

```graphql
query Detail($id: ID!, $tsf: TimeSeriesFilter!) {
  asset(id: $id) {
    id
    name
    altValueInfo(tsFilter: $tsf) { currentAltValue }
    cardPops { gradingCompany gradeNumber count }
  }
}
```

variables：

```json
{
  "id": "<第1步拿到的 asset.id>",
  "tsf": {
    "startDate": "<今天往前2年，格式 YYYY-MM-DD>",
    "endDate": "<明天，格式 YYYY-MM-DD>",
    "gradingCompany": "<第1步的 gradingCompany>",
    "gradeNumber": "<第1步的 gradeNumber，转成字符串>"
  }
}
```

## 返回字段处理

- **名称**：`asset.name`
- **评级**：拼接 `gradingCompany + ' ' + gradeNumber`（如 `PSA 10`）
- **Alt 价格**：`asset.altValueInfo.currentAltValue`（可能为 null）
- **总 POP**：`cardPops` 中所有 `count` 求和
- **分公司 POP**：按 `gradingCompany` 分组累加 `count`，格式如 `PSA:12,345 / BGS:678`

## 错误处理约定

- HTTP 状态非 2xx → 抛 `HTTP <status>`。
- 响应 body 里有 `errors` 数组 → 取 `errors[0].message` 抛出。
- **重试策略**：每个请求失败后指数退避重试，最多 4 次，间隔依次为 1s / 2s / 4s。

## 并发建议

逐条查询时限制并发数（本项目用 **3**），避免触发代理限流。

## 参考实现（TypeScript）

```ts
const API = 'https://proxy.kevinzhang.fun/pokeprice';
const API_KEY = 'J_4tM1IBP304QF3y9eFqnfSpy7efTTGPg6MCncATHXc';

const INITIAL_CERT_QUERY = `query InitialCert($certNumber: String!) { cert(certNumber: $certNumber) { certNumber gradeNumber gradingCompany asset { id } } }`;
const DETAIL_QUERY = `query Detail($id: ID!, $tsf: TimeSeriesFilter!) {
  asset(id: $id) { id name altValueInfo(tsFilter: $tsf) { currentAltValue } cardPops { gradingCompany gradeNumber count } }
}`;

async function gql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

export async function queryCert(no: string) {
  const tsf = {
    startDate: new Date(new Date().setFullYear(new Date().getFullYear() - 2)).toISOString().split('T')[0],
    endDate: new Date(new Date().setDate(new Date().getDate() + 1)).toISOString().split('T')[0],
  };
  const initial = await gql(INITIAL_CERT_QUERY, { certNumber: no });
  if (!initial?.cert?.asset?.id) throw new Error('CERT NOT FOUND');
  const cert = initial.cert;
  const detail = await gql(DETAIL_QUERY, {
    id: cert.asset.id,
    tsf: { ...tsf, gradingCompany: cert.gradingCompany, gradeNumber: String(cert.gradeNumber) },
  });
  const asset = detail.asset;
  const pops = asset.cardPops || [];
  const totalPop = pops.reduce((a: number, p: any) => a + (p.count || 0), 0);
  const popByCo = Object.entries(
    pops.reduce((acc: Record<string, number>, p: any) => { acc[p.gradingCompany] = (acc[p.gradingCompany] || 0) + p.count; return acc; }, {})
  ).map(([co, n]) => `${co}:${(n as number).toLocaleString()}`).join(' / ');
  return {
    name: asset.name || '—',
    grade: `${cert.gradingCompany} ${cert.gradeNumber}`,
    alt: asset.altValueInfo?.currentAltValue ?? null,
    totalPop,
    popByCo,
  };
}
```
