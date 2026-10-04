const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MACHINE_REBINDS = 3;
const DEFAULT_PRODUCT_ID = "legend-comic-generator";
const DEFAULT_CHECK_INTERVAL_HOURS = 24;
const DEFAULT_LAST_SEEN_WRITE_HOURS = 6;

const SOFTWARE_CATALOG = Object.freeze({
  "comic-svip-pc": "漫画SVIP-PC端",
  "comic-svip-pc-mobile": "漫画SVIP-PC移动端",
  "huanhua-svip-mobile": "幻画SVIP-移动端",
  "douyin-cover-pc": "抖音封面截图-PC端",
  "manju-doubao": "漫剧豆包版",
  "manju-h3": "漫剧H3版",
  "legend-manju-workbench": "传奇漫剧工作台",
  "legend-canvas": "传奇画布",
  "dialogue-factory-pc": "对白工厂-PC端",
  "dialogue-factory-mobile": "对白工厂-移动端",
  "confession-mobile": "表白-移动端",
  "heima-mobile": "黑马-移动端",
  "comic-trial-pc": "漫画试用版-PC端",
});
const ALLOWED_SOFTWARE = new Set(Object.keys(SOFTWARE_CATALOG));
const RETIRED_SOFTWARE = new Set(["comic-svip-pc-mobile"]);

let memoryCache = null;
let memoryCacheUntil = 0;
let memoryCacheKey = "";
let signingKeyCache = null;
let signingKeySource = "";
let d1SchemaReady = false;

class HttpError extends Error {
  constructor(message, status = 400, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function productId(env) {
  return String(env.PRODUCT_ID || DEFAULT_PRODUCT_ID);
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeEdition(value) {
  return String(value || "").trim().toLowerCase() === "trial" ? "trial" : "customer";
}

function normalizeSoftwareId(value, edition = "customer") {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    customer: "comic-svip-pc",
    trial: "comic-trial-pc",
    "legend-comic-generator:customer": "comic-svip-pc",
    "legend-comic-generator:trial": "comic-trial-pc",
    "黑马-移动端": "heima-mobile",
    "黑马移动端": "heima-mobile",
    heima: "heima-mobile",
    "heima-android": "heima-mobile",
    heima_mobile: "heima-mobile",
    "漫剧豆包版": "manju-doubao",
    "漫剧豆包": "manju-doubao",
    manju_doubao: "manju-doubao",
    "漫剧h3版": "manju-h3",
    "漫剧h3": "manju-h3",
    manju_h3: "manju-h3",
    "传奇漫剧工作台": "legend-manju-workbench",
    "传奇漫剧工作台-pc端": "legend-manju-workbench",
    "legend-manju": "legend-manju-workbench",
    legend_manju_workbench: "legend-manju-workbench",
    "传奇画布": "legend-canvas",
    "legend-canvas-pc": "legend-canvas",
    legend_canvas: "legend-canvas",
  };
  const normalized = aliases[raw] || raw;
  if (ALLOWED_SOFTWARE.has(normalized)) return normalized;
  return normalizeEdition(edition) === "trial" ? "comic-trial-pc" : "comic-svip-pc";
}

function requestedEdition(body = {}) {
  return normalizeEdition(body.edition || body.licenseEdition || body.packageEdition);
}

function requestedSoftwareId(body = {}) {
  return normalizeSoftwareId(
    body.softwareId || body.appId || body.productVariant || body.softwareVersion,
    requestedEdition(body),
  );
}

function requestedCreatableSoftwareId(body = {}) {
  const softwareId = requestedSoftwareId(body);
  if (RETIRED_SOFTWARE.has(softwareId)) {
    throw new HttpError("漫画SVIP-PC移动端已停止新增授权码");
  }
  return softwareId;
}

function recordEdition(record = {}) {
  return normalizeEdition(record.edition);
}

function recordSoftwareId(record = {}) {
  return normalizeSoftwareId(
    record.softwareId || record.appId || record.productVariant || record.softwareVersion,
    recordEdition(record),
  );
}

function softwareLabel(softwareId) {
  const normalized = normalizeSoftwareId(softwareId);
  return SOFTWARE_CATALOG[normalized] || SOFTWARE_CATALOG["comic-svip-pc"];
}

function packageScopeForSoftware(env, softwareId) {
  return `${productId(env)}:${normalizeSoftwareId(softwareId)}`;
}

function recordPackageScope(env, record = {}) {
  return String(record.packageScope || packageScopeForSoftware(env, recordSoftwareId(record))).trim();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function sanitizeHardwareProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = String(key || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
    const safeValue = String(raw || "").trim().toLowerCase();
    if (safeKey && /^[a-f0-9]{8,64}$/.test(safeValue)) output[safeKey] = safeValue;
  }
  return output;
}

function machineMetaFromBody(body = {}) {
  const version = Number(body.hardwareFingerprintVersion || 0);
  return {
    machineCode: String(body.machineCode || "").trim().toUpperCase().slice(0, 64),
    hardwareFingerprintHash: normalizeHash(body.hardwareFingerprintHash),
    hardwareFingerprintVersion: Number.isFinite(version) ? Math.max(0, version) : 0,
    hardwareProfile: sanitizeHardwareProfile(body.hardwareProfile),
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function utf8ToBase64(value) {
  return bytesToBase64(new TextEncoder().encode(value));
}

function base64ToUtf8(value) {
  return new TextDecoder().decode(base64ToBytes(value));
}

async function signingKey(env) {
  const source = String(env.LICENSE_PRIVATE_KEY_B64 || "").trim();
  if (!source) throw new HttpError("LICENSE_PRIVATE_KEY_B64 is not configured", 503);
  if (signingKeyCache && signingKeySource === source) return signingKeyCache;
  const pem = base64ToUtf8(source);
  const der = base64ToBytes(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, ""));
  signingKeyCache = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  signingKeySource = source;
  return signingKeyCache;
}

async function signPayload(env, payload) {
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    await signingKey(env),
    new TextEncoder().encode(stableStringify(payload)),
  );
  return bytesToBase64(new Uint8Array(signature));
}

function githubConfig(env) {
  const owner = String(env.GITHUB_OWNER || "").trim();
  const repo = String(env.GITHUB_REPO || "").trim();
  const branch = String(env.GITHUB_BRANCH || "main").trim();
  const path = String(env.GITHUB_DATA_PATH || "data/licenses.json").replace(/^\/+/, "");
  const token = String(env.GITHUB_TOKEN || "").trim();
  if (!owner || !repo || !token) throw new HttpError("GitHub storage is not configured", 503);
  return { owner, repo, branch, path, token };
}

function githubFileUrl(config) {
  const encodedPath = config.path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}`;
}

function githubHeaders(config) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.token}`,
    "User-Agent": "chuanqiai-license-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function cacheIdentity(config) {
  return `${config.owner}/${config.repo}/${config.branch}/${config.path}`;
}

function normalizeStore(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { codes: {} };
  if (!data.codes || typeof data.codes !== "object" || Array.isArray(data.codes)) data.codes = {};
  return data;
}

function d1Database(env) {
  const database = env.LICENSE_DB;
  return database && typeof database.prepare === "function" ? database : null;
}

function storageBackend(env) {
  return d1Database(env) ? "cloudflare-d1" : "github-private-repository";
}

async function readGitHubStore(env, options = {}) {
  const config = githubConfig(env);
  const identity = cacheIdentity(config);
  if (!options.fresh && memoryCache && memoryCacheKey === identity && Date.now() < memoryCacheUntil) {
    return { store: structuredClone(memoryCache.store), sha: memoryCache.sha };
  }
  const response = await fetch(`${githubFileUrl(config)}?ref=${encodeURIComponent(config.branch)}`, {
    headers: githubHeaders(config),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new HttpError(`读取 GitHub 授权数据失败：${detail.message || response.status}`, 502);
  }
  const file = await response.json();
  const store = normalizeStore(JSON.parse(base64ToUtf8(file.content)));
  memoryCache = { store: structuredClone(store), sha: file.sha };
  memoryCacheUntil = Date.now() + Math.max(1000, Number(env.STORE_CACHE_SECONDS || 10) * 1000);
  memoryCacheKey = identity;
  return { store, sha: file.sha };
}

async function writeGitHubStore(env, store, sha, message) {
  const config = githubConfig(env);
  const response = await fetch(githubFileUrl(config), {
    method: "PUT",
    headers: { ...githubHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(`${JSON.stringify(store, null, 2)}\n`),
      sha,
      branch: config.branch,
    }),
  });
  if (response.status === 409 || response.status === 422) {
    throw new HttpError("GitHub data changed concurrently", 409, "GITHUB_CONFLICT");
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new HttpError(`写入 GitHub 授权数据失败：${detail.message || response.status}`, 502);
  }
  const result = await response.json();
  const nextSha = result.content?.sha || sha;
  const configIdentity = cacheIdentity(config);
  memoryCache = { store: structuredClone(store), sha: nextSha };
  memoryCacheUntil = Date.now() + Math.max(1000, Number(env.STORE_CACHE_SECONDS || 10) * 1000);
  memoryCacheKey = configIdentity;
  return nextSha;
}

async function ensureD1Schema(env) {
  const database = d1Database(env);
  if (!database) throw new HttpError("D1 storage is not configured", 503);
  if (d1SchemaReady) return database;
  await database.prepare(`
    CREATE TABLE IF NOT EXISTS license_store (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      imported_at TEXT NOT NULL
    )
  `).run();
  d1SchemaReady = true;
  return database;
}

function parseD1Row(row) {
  if (!row) return null;
  try {
    return {
      store: normalizeStore(JSON.parse(String(row.data || "{}"))),
      sha: String(Math.max(1, Number(row.version || 1))),
      metadata: {
        updatedAt: String(row.updated_at || ""),
        importedAt: String(row.imported_at || ""),
      },
    };
  } catch {
    throw new HttpError("D1 授权数据格式损坏", 500);
  }
}

async function importGitHubStoreIntoD1(env, database) {
  const imported = await readGitHubStore(env, { fresh: true });
  const now = nowIso();
  await database.prepare(`
    INSERT OR IGNORE INTO license_store (id, data, version, updated_at, imported_at)
    VALUES (1, ?, 1, ?, ?)
  `).bind(JSON.stringify(imported.store), now, now).run();
  const row = await database.prepare(
    "SELECT data, version, updated_at, imported_at FROM license_store WHERE id = 1",
  ).first();
  const parsed = parseD1Row(row);
  if (!parsed) throw new HttpError("D1 首次导入授权数据失败", 503);
  return parsed;
}

async function readD1Store(env, options = {}) {
  const identity = "d1:license_store:1";
  if (!options.fresh && memoryCache && memoryCacheKey === identity && Date.now() < memoryCacheUntil) {
    return {
      store: structuredClone(memoryCache.store),
      sha: memoryCache.sha,
      metadata: { ...(memoryCache.metadata || {}) },
    };
  }
  const database = await ensureD1Schema(env);
  const row = await database.prepare(
    "SELECT data, version, updated_at, imported_at FROM license_store WHERE id = 1",
  ).first();
  const current = parseD1Row(row) || await importGitHubStoreIntoD1(env, database);
  memoryCache = {
    store: structuredClone(current.store),
    sha: current.sha,
    metadata: { ...(current.metadata || {}) },
  };
  memoryCacheUntil = Date.now() + Math.max(1000, Number(env.STORE_CACHE_SECONDS || 10) * 1000);
  memoryCacheKey = identity;
  return current;
}

async function writeD1Store(env, store, sha) {
  const database = await ensureD1Schema(env);
  const expectedVersion = Math.max(1, Number(sha || 1));
  const updatedAt = nowIso();
  const result = await database.prepare(`
    UPDATE license_store
    SET data = ?, version = version + 1, updated_at = ?
    WHERE id = 1 AND version = ?
  `).bind(JSON.stringify(store), updatedAt, expectedVersion).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw new HttpError("D1 data changed concurrently", 409, "STORE_CONFLICT");
  }
  const nextVersion = String(expectedVersion + 1);
  const identity = "d1:license_store:1";
  const importedAt = String(memoryCache?.metadata?.importedAt || "");
  memoryCache = {
    store: structuredClone(store),
    sha: nextVersion,
    metadata: { updatedAt, importedAt },
  };
  memoryCacheUntil = Date.now() + Math.max(1000, Number(env.STORE_CACHE_SECONDS || 10) * 1000);
  memoryCacheKey = identity;
  return nextVersion;
}

async function readStore(env, options = {}) {
  return d1Database(env) ? readD1Store(env, options) : readGitHubStore(env, options);
}

async function writeStore(env, store, sha, message) {
  return d1Database(env) ? writeD1Store(env, store, sha) : writeGitHubStore(env, store, sha, message);
}

async function backupD1StoreToGitHub(env) {
  if (!d1Database(env)) throw new HttpError("D1 storage is not configured", 503);
  const d1Current = await readD1Store(env, { fresh: true });
  const githubCurrent = await readGitHubStore(env, { fresh: true });
  const licenseCount = Object.keys(d1Current.store.codes || {}).length;
  if (JSON.stringify(d1Current.store) === JSON.stringify(githubCurrent.store)) {
    return { ok: true, backedUp: false, licenseCount, message: "GitHub 备份已是最新" };
  }
  await writeGitHubStore(
    env,
    d1Current.store,
    githubCurrent.sha,
    `Backup D1 license store revision ${d1Current.sha}`,
  );
  return { ok: true, backedUp: true, licenseCount, revision: d1Current.sha, message: "D1 授权数据已备份到 GitHub" };
}

async function mutateStore(env, message, mutator) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { store, sha } = await readStore(env, { fresh: true });
    const draft = structuredClone(store);
    const outcome = await mutator(draft);
    if (outcome.write === false) return outcome.value;
    try {
      await writeStore(env, draft, sha, message);
      return outcome.value;
    } catch (error) {
      lastError = error;
      if (error.code !== "GITHUB_CONFLICT" && error.code !== "STORE_CONFLICT") throw error;
    }
  }
  throw lastError || new HttpError("授权数据并发更新失败", 503);
}

function planDays(plan) {
  const key = String(plan || "").trim().toLowerCase();
  if (["month", "monthly", "月卡", "月"].includes(key)) return 30;
  if (["quarter", "quarterly", "season", "季卡", "季"].includes(key)) return 90;
  if (["year", "yearly", "annual", "年卡", "年"].includes(key)) return 365;
  return 0;
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const token = bytesToBase64(bytes).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);
  return `CG-${token.match(/.{1,4}/g).join("-")}`;
}

function calculateExpiryFromActivation(days, now = Date.now()) {
  const date = new Date(now + Math.max(1, Number(days || 0)) * DAY_MS);
  date.setUTCHours(23, 59, 59, 999);
  return date.toISOString();
}

function machineHistoryStarted(record = {}) {
  const machines = record.machines && typeof record.machines === "object" ? record.machines : {};
  return Boolean(record.activatedAt) || Object.keys(machines).length > 0 || Boolean(record.lastUnboundAt) ||
    (Array.isArray(record.unbindHistory) && record.unbindHistory.length > 0);
}

function startLicensePeriodIfNeeded(record, options, now) {
  record.machines = record.machines && typeof record.machines === "object" ? record.machines : {};
  if (machineHistoryStarted(record) && Number.isFinite(Date.parse(record.expiresAt || ""))) return false;
  if (options.verifyOnly) throw new HttpError("license is not activated");
  const days = Math.max(1, Number(record.days || planDays(record.plan) || 30));
  record.days = days;
  record.activatedAt = nowIso(now);
  record.expiresAt = calculateExpiryFromActivation(days, now);
  return true;
}

function matchingHardwareProfileKey(record, machineMeta) {
  const current = machineMeta.hardwareProfile || {};
  const machines = record.machines && typeof record.machines === "object" ? record.machines : {};
  if (current.machineGuid) {
    for (const [key, machine] of Object.entries(machines)) {
      if (machine?.hardwareProfile?.machineGuid === current.machineGuid) return key;
    }
  }
  const stableKeys = ["biosUuid", "baseboardSerial", "biosSerial", "systemDiskSerial", "systemVolumeSerial"];
  let bestKey = "";
  let bestScore = 0;
  for (const [key, machine] of Object.entries(machines)) {
    const profile = machine?.hardwareProfile || {};
    const score = stableKeys.filter((field) => current[field] && profile[field] === current[field]).length;
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestScore >= 2 ? bestKey : "";
}

function shouldWriteLastSeen(env, previous, now) {
  const interval = Math.max(1, Number(env.LAST_SEEN_WRITE_HOURS || DEFAULT_LAST_SEEN_WRITE_HOURS)) * 60 * 60 * 1000;
  const lastSeen = Date.parse(previous || "");
  return !Number.isFinite(lastSeen) || now - lastSeen >= interval;
}

function updateMachineBinding(env, record, machineCodeHash, machineMeta, body, now, previousHash = "") {
  const current = previousHash ? (record.machines[previousHash] || {}) : (record.machines[machineCodeHash] || {});
  const isNew = !record.machines[machineCodeHash] || Boolean(previousHash);
  const next = {
    ...current,
    machineCode: machineMeta.machineCode || current.machineCode || String(body.machineCode || ""),
    boundAt: current.boundAt || nowIso(now),
    lastSeenAt: isNew || shouldWriteLastSeen(env, current.lastSeenAt, now) ? nowIso(now) : current.lastSeenAt,
    hardwareFingerprintHash: machineMeta.hardwareFingerprintHash || current.hardwareFingerprintHash || "",
    hardwareFingerprintVersion: machineMeta.hardwareFingerprintVersion || current.hardwareFingerprintVersion || 0,
    hardwareProfile: Object.keys(machineMeta.hardwareProfile).length ? machineMeta.hardwareProfile : (current.hardwareProfile || {}),
  };
  let dirty = isNew || stableStringify(next) !== stableStringify(current);
  if (previousHash && previousHash !== machineCodeHash) {
    record.machineRebindCount = Math.max(0, Number(record.machineRebindCount || 0)) + 1;
    record.lastMachineReboundAt = nowIso(now);
    record.machineRebindHistory = Array.isArray(record.machineRebindHistory) ? record.machineRebindHistory : [];
    record.machineRebindHistory.push({
      reboundAt: record.lastMachineReboundAt,
      fromMachineCodeHash: previousHash,
      fromMachineCode: current.machineCode || "",
      toMachineCodeHash: machineCodeHash,
      toMachineCode: machineMeta.machineCode || String(body.machineCode || ""),
      hardwareFingerprintHash: machineMeta.hardwareFingerprintHash || "",
    });
    record.machineRebindHistory = record.machineRebindHistory.slice(-20);
    next.previousMachineCodeHash = previousHash;
    next.reboundAt = record.lastMachineReboundAt;
    delete record.machines[previousHash];
    dirty = true;
  }
  record.machines[machineCodeHash] = next;
  return dirty;
}

async function normalizedMachineHash(body) {
  const provided = String(body.machineCodeHash || "").trim();
  return provided || sha256Hex(body.machineCode || "");
}

async function ensureLicenseCanUse(env, record, body, options, now) {
  if (!record) throw new HttpError("activation code not found", 404);
  if (record.disabled) throw new HttpError("activation code is disabled", 403);
  if ((record.productId || productId(env)) !== body.productId) throw new HttpError("product mismatch");
  const requested = requestedSoftwareId(body);
  const licensed = recordSoftwareId(record);
  if (licensed !== requested) {
    throw new HttpError(`激活码版本不匹配：该码是${softwareLabel(licensed)}，当前软件是${softwareLabel(requested)}`);
  }
  let dirty = startLicensePeriodIfNeeded(record, options, now);
  const expiresAt = Date.parse(record.expiresAt || "");
  if (!Number.isFinite(expiresAt)) throw new HttpError("license expiry is invalid");
  if (now >= expiresAt) throw new HttpError("license expired", 403);
  const machineCodeHash = await normalizedMachineHash(body);
  if (!machineCodeHash) throw new HttpError("machine code is required");
  const machineMeta = machineMetaFromBody(body);
  record.machines = record.machines && typeof record.machines === "object" ? record.machines : {};
  if (record.machines[machineCodeHash]) {
    dirty = updateMachineBinding(env, record, machineCodeHash, machineMeta, body, now) || dirty;
    return { machineCodeHash, dirty };
  }
  const matched = matchingHardwareProfileKey(record, machineMeta);
  if (matched) {
    if (Math.max(0, Number(record.machineRebindCount || 0)) >= MAX_MACHINE_REBINDS) {
      throw new HttpError("activation code has reached its machine rebind limit", 403);
    }
    updateMachineBinding(env, record, machineCodeHash, machineMeta, body, now, matched);
    return { machineCodeHash, dirty: true };
  }
  if (options.verifyOnly) throw new HttpError("license is not bound to this machine", 403);
  if (Object.keys(record.machines).length >= Math.max(1, Number(record.maxMachines || 1))) {
    throw new HttpError("activation code has reached its machine limit", 403);
  }
  updateMachineBinding(env, record, machineCodeHash, machineMeta, body, now);
  return { machineCodeHash, dirty: true };
}

function nextCheckAt(env, expiresAt, now) {
  const expires = Date.parse(expiresAt);
  const interval = Math.max(1, Number(env.CHECK_INTERVAL_HOURS || DEFAULT_CHECK_INTERVAL_HOURS));
  const next = now + interval * 60 * 60 * 1000;
  return new Date(Number.isFinite(expires) ? Math.min(next, expires) : next).toISOString();
}

async function buildPayload(env, code, record, body, machineCodeHash, now) {
  const machine = record.machines?.[machineCodeHash] || {};
  const edition = recordEdition(record);
  const softwareId = recordSoftwareId(record);
  const licenseHash = await sha256Hex(code);
  return {
    licenseId: record.licenseId || licenseHash.slice(0, 16),
    productId: record.productId || productId(env),
    edition,
    softwareId,
    softwareName: softwareLabel(softwareId),
    packageScope: recordPackageScope(env, record),
    appVersion: String(body.appVersion || ""),
    machineCodeHash,
    hardwareFingerprintHash: machine.hardwareFingerprintHash || "",
    hardwareFingerprintVersion: machine.hardwareFingerprintVersion || 0,
    hardwareProfile: machine.hardwareProfile || {},
    issuedAt: nowIso(now),
    expiresAt: new Date(record.expiresAt).toISOString(),
    nextCheckAt: nextCheckAt(env, record.expiresAt, now),
    name: record.name || "",
    plan: record.plan || "",
    days: Number(record.days || 0),
  };
}

async function activationResult(env, store, body, options = {}) {
  const code = normalizeCode(body.code);
  if (!code) throw new HttpError("activation code is required");
  if (!body.productId) throw new HttpError("productId is required");
  const now = Date.now();
  const record = store.codes[code];
  const { machineCodeHash, dirty } = await ensureLicenseCanUse(env, record, body, options, now);
  const payload = await buildPayload(env, code, record, body, machineCodeHash, now);
  return { dirty, response: { ok: true, payload, signature: await signPayload(env, payload) } };
}

async function activate(env, body, options = {}) {
  const initial = await readStore(env);
  const draft = structuredClone(initial.store);
  const preview = await activationResult(env, draft, body, options);
  if (!preview.dirty) return preview.response;
  return mutateStore(env, options.verifyOnly ? "Verify license binding" : "Activate license", async (latest) => {
    const result = await activationResult(env, latest, body, options);
    return { write: result.dirty, value: result.response };
  });
}

function legacyCardFailure(error) {
  return {
    code: Math.max(1, Number(error?.status || 1)),
    message: String(error?.message || "license verification failed"),
    result: null,
  };
}

async function forwardLegacyCardRequest(env, pathname, body) {
  const baseUrl = String(env.LEGACY_CARD_API_URL || "http://api.paojiaoyun.com").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new HttpError("legacy license service returned an invalid response", 502);
  }
  if (!response.ok || !result || typeof result !== "object") {
    throw new HttpError(result?.message || "legacy license service is unavailable", 502);
  }
  return result;
}

async function legacyCardLogin(env, body = {}) {
  try {
    const result = await activate(env, {
      code: body.card,
      productId: productId(env),
      softwareId: "heima-mobile",
      machineCode: String(body.device_id || "").trim(),
      appVersion: "heima-android-1.3",
    });
    const payload = result.payload || {};
    const expiresAt = String(payload.expiresAt || "");
    const expires = Number.isFinite(Date.parse(expiresAt))
      ? expiresAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")
      : expiresAt;
    return {
      code: 0,
      message: "授权成功",
      result: {
        card_type: payload.softwareName || "黑马-移动端",
        token: result.signature || payload.licenseId || "verified",
        expires,
        expires_ts: Math.floor(Date.parse(expiresAt) / 1000) || 0,
        server_time: Math.floor(Date.now() / 1000),
        config: "",
      },
    };
  } catch (error) {
    if (Number(error?.status) === 404 && normalizeCode(body.card)) {
      try {
        const legacyResult = await forwardLegacyCardRequest(env, "/v1/card/login", body);
        if (Number(legacyResult.code) === 0 && legacyResult.result && typeof legacyResult.result === "object") {
          legacyResult.result.card_type = "黑马-移动端";
        }
        return legacyResult;
      } catch (legacyError) {
        return legacyCardFailure(legacyError);
      }
    }
    return legacyCardFailure(error);
  }
}

async function legacyCardUnbind(env, body = {}) {
  try {
    const result = await unbindLicenseMachine(env, {
      code: body.card,
      machineCode: String(body.device_id || "").trim(),
      reason: "heima-mobile self-service unbind",
    });
    return { code: 0, message: result.message || "解绑成功", result: result.message || "解绑成功" };
  } catch (error) {
    if (Number(error?.status) === 404 && normalizeCode(body.card)) {
      try {
        return await forwardLegacyCardRequest(env, "/v1/card/unbind_device", body);
      } catch (legacyError) {
        return legacyCardFailure(legacyError);
      }
    }
    return legacyCardFailure(error);
  }
}

function listLicenseCodes(env, store) {
  return Object.entries(store.codes || {}).map(([code, record]) => ({
    code,
    productId: record.productId || productId(env),
    edition: recordEdition(record),
    softwareId: recordSoftwareId(record),
    softwareName: softwareLabel(recordSoftwareId(record)),
    packageScope: recordPackageScope(env, record),
    name: record.name || "",
    wechat: record.wechat || "",
    phone: record.phone || "",
    orderNo: record.orderNo || "",
    sales: record.sales || "",
    remark: record.remark || "",
    plan: record.plan || "",
    days: Number(record.days || 0),
    activatedAt: record.activatedAt || "",
    expiresAt: record.expiresAt || "",
    startsOnActivation: record.startsOnActivation !== false,
    maxMachines: Number(record.maxMachines || 1),
    usedMachines: Object.keys(record.machines || {}).length,
    disabled: record.disabled === true,
    createdAt: record.createdAt || "",
    machineRebindCount: Math.max(0, Number(record.machineRebindCount || 0)),
    maxMachineRebinds: MAX_MACHINE_REBINDS,
    lastMachineReboundAt: record.lastMachineReboundAt || "",
    machines: Object.entries(record.machines || {}).map(([machineCodeHash, machine]) => ({
      machineCodeHash,
      machineCode: machine.machineCode || "",
      hardwareFingerprintHash: machine.hardwareFingerprintHash || "",
      hardwareFingerprintVersion: machine.hardwareFingerprintVersion || 0,
      boundAt: machine.boundAt || "",
      lastSeenAt: machine.lastSeenAt || "",
    })),
  })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function publicLicenseInfo(env, code, record) {
  return listLicenseCodes(env, { codes: { [code]: record } })[0] || null;
}

function licenseRecord(env, body, days, plan, now) {
  const edition = requestedEdition(body);
  const softwareId = requestedCreatableSoftwareId(body);
  return {
    productId: String(body.productId || productId(env)),
    edition,
    softwareId,
    packageScope: packageScopeForSoftware(env, softwareId),
    name: String(body.name || "").trim(),
    wechat: String(body.wechat || "").trim(),
    phone: String(body.phone || "").trim(),
    orderNo: String(body.orderNo || "").trim(),
    sales: String(body.sales || "").trim(),
    remark: String(body.remark || "").trim(),
    plan: plan || `${days}d`,
    days,
    activatedAt: "",
    expiresAt: "",
    startsOnActivation: true,
    maxMachines: Math.max(1, Number(body.maxMachines || 1)),
    disabled: false,
    machines: {},
    createdAt: nowIso(now),
  };
}

async function createLicenseCodes(env, body = {}) {
  const count = Math.max(1, Math.min(500, Number(body.count || 1)));
  const plan = String(body.plan || "").trim();
  const days = Math.max(1, Number(body.days || planDays(plan) || 30));
  return mutateStore(env, `Create ${count} license code(s)`, async (store) => {
    const items = [];
    for (let index = 0; index < count; index += 1) {
      let code = count === 1 && body.code ? normalizeCode(body.code) : "";
      if (code && store.codes[code]) throw new HttpError("activation code already exists", 409);
      for (let attempt = 0; !code && attempt < 20; attempt += 1) {
        const candidate = normalizeCode(randomCode());
        if (!store.codes[candidate]) code = candidate;
      }
      if (!code) throw new HttpError("failed to generate a unique activation code", 503);
      const record = licenseRecord(env, body, days, plan, Date.now());
      store.codes[code] = record;
      items.push({ code, ...record });
    }
    return { value: { ok: true, item: items[0] || null, items } };
  });
}

function requestedCodes(body = {}) {
  const values = Array.isArray(body.codes) ? body.codes : [body.code || ""];
  const codes = values.map(normalizeCode).filter(Boolean);
  if (!codes.length) throw new HttpError("activation code is required");
  return codes;
}

async function setLicenseDisabled(env, body = {}) {
  const codes = requestedCodes(body);
  const disabled = body.disabled !== false;
  return mutateStore(env, `${disabled ? "Disable" : "Enable"} ${codes.length} license(s)`, async (store) => {
    const missing = [];
    const items = [];
    const now = nowIso();
    for (const code of codes) {
      const record = store.codes[code];
      if (!record) missing.push(code);
      else {
        record.disabled = disabled;
        record.disabledUpdatedAt = now;
        items.push(publicLicenseInfo(env, code, record));
      }
    }
    return { value: { ok: true, updated: items.length, missing, items, message: disabled ? `已停用 ${items.length} 个激活码` : `已恢复 ${items.length} 个激活码` } };
  });
}

async function deleteLicenseCodes(env, body = {}) {
  const codes = requestedCodes(body);
  return mutateStore(env, `Delete ${codes.length} license(s)`, async (store) => {
    const missing = [];
    const deleted = [];
    for (const code of codes) {
      if (!store.codes[code]) missing.push(code);
      else {
        delete store.codes[code];
        deleted.push(code);
      }
    }
    return { value: { ok: true, deleted: deleted.length, missing, codes: deleted, message: `已删除 ${deleted.length} 个激活码` } };
  });
}

async function unbindLicenseMachine(env, body = {}) {
  const code = normalizeCode(body.code || "");
  if (!code) throw new HttpError("activation code is required");
  return mutateStore(env, "Unbind license machine", async (store) => {
    const record = store.codes[code];
    if (!record) throw new HttpError("activation code not found", 404);
    record.machines = record.machines && typeof record.machines === "object" ? record.machines : {};
    const keys = Object.keys(record.machines);
    let targets = [];
    if (body.all === true) targets = keys;
    else {
      const requestedHash = String(body.machineCodeHash || "").trim();
      const requestedMachine = String(body.machineCode || "").trim().toUpperCase();
      const hash = requestedHash || (requestedMachine ? await sha256Hex(requestedMachine) : "");
      if (hash && record.machines[hash]) targets = [hash];
      else if (requestedMachine) targets = keys.filter((key) => String(record.machines[key]?.machineCode || "").toUpperCase() === requestedMachine);
      else if (keys.length === 1) targets = [keys[0]];
      else if (keys.length > 1) throw new HttpError("multiple machines are bound; machineCodeHash or all=true is required");
    }
    if (!targets.length) {
      return { write: false, value: { ok: true, unbound: 0, item: publicLicenseInfo(env, code, record), message: "no matching machine binding found" } };
    }
    const now = nowIso();
    record.unbindHistory = Array.isArray(record.unbindHistory) ? record.unbindHistory : [];
    for (const key of targets) {
      const machine = record.machines[key];
      if (!machine) continue;
      record.unbindHistory.push({
        unboundAt: now,
        machineCodeHash: key,
        machineCode: machine.machineCode || "",
        hardwareFingerprintHash: machine.hardwareFingerprintHash || "",
        reason: String(body.reason || "").slice(0, 120),
      });
      delete record.machines[key];
    }
    record.unbindHistory = record.unbindHistory.slice(-100);
    record.lastUnboundAt = now;
    return { value: { ok: true, unbound: targets.length, item: publicLicenseInfo(env, code, record), message: targets.length === 1 ? "已解绑 1 台机器" : `已解绑 ${targets.length} 台机器` } };
  });
}

function requireAdmin(request, env) {
  const configured = String(env.ADMIN_TOKEN || "");
  if (!configured) throw new HttpError("ADMIN_TOKEN is not configured", 503);
  if (request.headers.get("X-Admin-Token") !== configured) throw new HttpError("admin token is invalid", 401);
}

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) throw new HttpError("Content-Type must be application/json", 415);
  try {
    return await request.json();
  } catch {
    throw new HttpError("request body must be valid JSON");
  }
}

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "https://admin.chuanqiai.xyz").split(",").map((value) => value.trim()).filter(Boolean));
}

function isPublicCorsPath(request) {
  const pathname = new URL(request.url).pathname;
  return pathname === "/health" || pathname.startsWith("/api/license/");
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (isPublicCorsPath(request)) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (origin && allowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("Origin") || "";
    if (!isPublicCorsPath(request) && origin && !allowedOrigins(env).has(origin)) {
      return json(request, env, { ok: false, error: "origin is not allowed" }, 403);
    }
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/")) {
    return Response.redirect(String(env.ADMIN_SITE_URL || "https://admin.chuanqiai.xyz/admin/"), 302);
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return json(request, env, { ok: true, productId: productId(env), storage: storageBackend(env), time: nowIso() });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/storage-status") {
    requireAdmin(request, env);
    const current = await readStore(env, { fresh: true });
    return json(request, env, {
      ok: true,
      backend: storageBackend(env),
      licenseCount: Object.keys(current.store.codes || {}).length,
      revision: current.sha,
      updatedAt: current.metadata?.updatedAt || "",
      importedAt: current.metadata?.importedAt || "",
    });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/storage-backup") {
    requireAdmin(request, env);
    return json(request, env, await backupD1StoreToGitHub(env));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/licenses") {
    requireAdmin(request, env);
    return json(request, env, { ok: true, items: listLicenseCodes(env, (await readStore(env, { fresh: true })).store) });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/licenses") {
    requireAdmin(request, env);
    return json(request, env, await createLicenseCodes(env, await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/licenses/disabled") {
    requireAdmin(request, env);
    return json(request, env, await setLicenseDisabled(env, await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/licenses/delete") {
    requireAdmin(request, env);
    return json(request, env, await deleteLicenseCodes(env, await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/licenses/unbind") {
    requireAdmin(request, env);
    return json(request, env, await unbindLicenseMachine(env, await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/license/activate") {
    return json(request, env, await activate(env, await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/api/license/verify") {
    return json(request, env, await activate(env, await readJson(request), { verifyOnly: true }));
  }
  if (request.method === "POST" && url.pathname === "/v1/card/login") {
    return json(request, env, await legacyCardLogin(env, await readJson(request)));
  }
  if (request.method === "POST" && url.pathname === "/v1/card/unbind_device") {
    return json(request, env, await legacyCardUnbind(env, await readJson(request)));
  }
  return json(request, env, { ok: false, error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      return json(request, env, { ok: false, error: error?.message || "internal error" }, error?.status || 400);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(backupD1StoreToGitHub(env));
  },
};

export {
  HttpError,
  normalizeCode,
  normalizeEdition,
  normalizeSoftwareId,
  requestedCreatableSoftwareId,
  storageBackend,
  readStore,
  backupD1StoreToGitHub,
  stableStringify,
  planDays,
  calculateExpiryFromActivation,
  listLicenseCodes,
};
