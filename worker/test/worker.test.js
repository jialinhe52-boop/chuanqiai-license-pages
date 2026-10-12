import test from "node:test";
import assert from "node:assert/strict";
import worker, { normalizeSoftwareId, readStore, requestedCreatableSoftwareId, stableStringify, storageBackend } from "../src/index.js";

function pem(label, bytes) {
  const body = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function createFakeD1() {
  const state = { row: null };
  return {
    state,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() {
          if (!sql.includes("SELECT data, version")) throw new Error(`unexpected D1 first: ${sql}`);
          return state.row ? { ...state.row } : null;
        },
        async run() {
          if (sql.includes("CREATE TABLE IF NOT EXISTS")) return { meta: { changes: 0 } };
          if (sql.includes("INSERT OR IGNORE INTO license_store")) {
            if (state.row) return { meta: { changes: 0 } };
            state.row = { data: values[0], version: 1, updated_at: values[1], imported_at: values[2] };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE license_store")) {
            if (!state.row || Number(state.row.version) !== Number(values[2])) return { meta: { changes: 0 } };
            state.row = { ...state.row, data: values[0], version: Number(state.row.version) + 1, updated_at: values[1] };
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected D1 run: ${sql}`);
        },
      };
    },
  };
}

test("激活、验签、后台查询和停用使用同一套兼容接口", async (context) => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const privatePem = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const code = "CG-TEST-0001";
  let store = {
    codes: {
      [code]: {
        productId: "legend-comic-generator",
        edition: "customer",
        softwareId: "comic-svip-pc",
        packageScope: "legend-comic-generator:comic-svip-pc",
        name: "测试客户",
        plan: "month",
        days: 30,
        activatedAt: "",
        expiresAt: "",
        startsOnActivation: true,
        maxMachines: 1,
        disabled: false,
        machines: {},
        createdAt: "2026-07-28T00:00:00.000Z"
      }
    }
  };
  let sha = "sha-0";
  let writes = 0;
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options = {}) => {
    if (!options.method || options.method === "GET") {
      return Response.json({ content: Buffer.from(JSON.stringify(store)).toString("base64"), sha });
    }
    if (options.method === "PUT") {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, sha);
      store = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      writes += 1;
      sha = `sha-${writes}`;
      return Response.json({ content: { sha } });
    }
    return Response.json({ message: "unexpected request" }, { status: 500 });
  };

  const env = {
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "data",
    GITHUB_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-secret",
    LICENSE_PRIVATE_KEY_B64: Buffer.from(privatePem).toString("base64"),
    PRODUCT_ID: "legend-comic-generator",
    ALLOWED_ORIGINS: "https://admin.chuanqiai.xyz",
    STORE_CACHE_SECONDS: "30",
  };
  const activationBody = {
    code,
    productId: "legend-comic-generator",
    softwareId: "comic-svip-pc",
    machineCode: "TEST-MACHINE-01",
    appVersion: "1.0.0",
  };

  const activation = await worker.fetch(new Request("https://license.example/api/license/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(activationBody),
  }), env);
  assert.equal(activation.status, 200);
  const activated = await activation.json();
  assert.equal(activated.ok, true);
  assert.equal(activated.payload.softwareId, "comic-svip-pc");
  assert.equal(writes, 1);
  const signatureOk = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    pair.publicKey,
    Buffer.from(activated.signature, "base64"),
    new TextEncoder().encode(stableStringify(activated.payload)),
  );
  assert.equal(signatureOk, true);

  const verify = await worker.fetch(new Request("https://license.example/api/license/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(activationBody),
  }), env);
  assert.equal(verify.status, 200);
  assert.equal((await verify.json()).ok, true);
  assert.equal(writes, 1, "短时间内重复验证不应为 lastSeenAt 反复提交 GitHub");

  const list = await worker.fetch(new Request("https://license.example/api/admin/licenses", {
    headers: { "X-Admin-Token": "admin-secret", Origin: "https://admin.chuanqiai.xyz" },
  }), env);
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].usedMachines, 1);

  const disabled = await worker.fetch(new Request("https://license.example/api/admin/licenses/disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": "admin-secret", Origin: "https://admin.chuanqiai.xyz" },
    body: JSON.stringify({ code, disabled: true }),
  }), env);
  assert.equal(disabled.status, 200);
  assert.equal(writes, 2);

  const rejected = await worker.fetch(new Request("https://license.example/api/license/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(activationBody),
  }), env);
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error, "activation code is disabled");
});

test("黑马-移动端使用独立的软件授权类型", async () => {
  assert.equal(normalizeSoftwareId("heima-mobile"), "heima-mobile");
  assert.equal(normalizeSoftwareId("黑马-移动端"), "heima-mobile");
  assert.equal(normalizeSoftwareId("黑马移动端"), "heima-mobile");
  assert.equal(normalizeSoftwareId("heima"), "heima-mobile");
  assert.equal(normalizeSoftwareId("heima-android"), "heima-mobile");
  assert.equal(normalizeSoftwareId("heima_mobile"), "heima-mobile");
  assert.equal(normalizeSoftwareId("comic-svip-pc-mobile"), "comic-svip-pc-mobile");
  assert.equal(normalizeSoftwareId("unknown-software"), "comic-svip-pc");

  const code = "CG-HEIMA-0001";
  const store = {
    codes: {
      [code]: {
        productId: "legend-comic-generator",
        edition: "customer",
        softwareId: "heima-mobile",
        packageScope: "legend-comic-generator:heima-mobile",
        days: 30,
        machines: {},
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ content: Buffer.from(JSON.stringify(store)).toString("base64"), sha: "sha-heima" });
  try {
    const response = await worker.fetch(new Request("https://license.example/api/admin/licenses", {
      headers: { "X-Admin-Token": "admin-secret", Origin: "https://admin.chuanqiai.xyz" },
    }), {
      GITHUB_OWNER: "heima-owner",
      GITHUB_REPO: "heima-data",
      GITHUB_TOKEN: "test-token",
      ADMIN_TOKEN: "admin-secret",
      ALLOWED_ORIGINS: "https://admin.chuanqiai.xyz",
      STORE_CACHE_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items[0].softwareId, "heima-mobile");
    assert.equal(body.items[0].softwareName, "黑马-移动端");
    assert.equal(body.items[0].packageScope, "legend-comic-generator:heima-mobile");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("对白工厂-PC端使用独立授权类型，漫画PC移动端停止新增", () => {
  assert.equal(normalizeSoftwareId("dialogue-factory-pc"), "dialogue-factory-pc");
  assert.equal(normalizeSoftwareId("dialogue-factory-mobile"), "dialogue-factory-mobile");
  assert.equal(requestedCreatableSoftwareId({ softwareId: "dialogue-factory-pc" }), "dialogue-factory-pc");
  assert.equal(normalizeSoftwareId("comic-svip-pc-mobile"), "comic-svip-pc-mobile");
  assert.throws(
    () => requestedCreatableSoftwareId({ softwareId: "comic-svip-pc-mobile" }),
    /已停止新增授权码/,
  );
});

test("漫剧豆包版和漫剧H3版使用互相隔离的授权类型", () => {
  assert.equal(normalizeSoftwareId("manju-doubao"), "manju-doubao");
  assert.equal(normalizeSoftwareId("漫剧豆包版"), "manju-doubao");
  assert.equal(normalizeSoftwareId("漫剧豆包"), "manju-doubao");
  assert.equal(normalizeSoftwareId("manju_doubao"), "manju-doubao");
  assert.equal(normalizeSoftwareId("manju-h3"), "manju-h3");
  assert.equal(normalizeSoftwareId("漫剧H3版"), "manju-h3");
  assert.equal(normalizeSoftwareId("漫剧H3"), "manju-h3");
  assert.equal(normalizeSoftwareId("manju_h3"), "manju-h3");
  assert.notEqual(normalizeSoftwareId("manju-doubao"), normalizeSoftwareId("manju-h3"));
  assert.equal(requestedCreatableSoftwareId({ softwareId: "manju-doubao" }), "manju-doubao");
  assert.equal(requestedCreatableSoftwareId({ softwareId: "manju-h3" }), "manju-h3");
});

test("传奇漫剧工作台和传奇画布使用独立授权类型", () => {
  assert.equal(normalizeSoftwareId("legend-manju-workbench"), "legend-manju-workbench");
  assert.equal(normalizeSoftwareId("传奇漫剧工作台"), "legend-manju-workbench");
  assert.equal(normalizeSoftwareId("传奇漫剧工作台-PC端"), "legend-manju-workbench");
  assert.equal(normalizeSoftwareId("legend-manju"), "legend-manju-workbench");
  assert.equal(normalizeSoftwareId("legend-canvas"), "legend-canvas");
  assert.equal(normalizeSoftwareId("传奇画布"), "legend-canvas");
  assert.equal(normalizeSoftwareId("legend-canvas-pc"), "legend-canvas");
  assert.notEqual(normalizeSoftwareId("legend-manju-workbench"), normalizeSoftwareId("legend-canvas"));
  assert.equal(requestedCreatableSoftwareId({ softwareId: "legend-manju-workbench" }), "legend-manju-workbench");
  assert.equal(requestedCreatableSoftwareId({ softwareId: "legend-canvas" }), "legend-canvas");
});

test("传奇画布PRO使用独立授权类型", () => {
  assert.equal(normalizeSoftwareId("legend-canvas-pro"), "legend-canvas-pro");
  assert.equal(normalizeSoftwareId("传奇画布PRO"), "legend-canvas-pro");
  assert.equal(normalizeSoftwareId("传奇画布PRO-PC端"), "legend-canvas-pro");
  assert.equal(normalizeSoftwareId("legend-canvas-pro-pc"), "legend-canvas-pro");
  assert.equal(normalizeSoftwareId("legend_canvas_pro"), "legend-canvas-pro");
  assert.notEqual(normalizeSoftwareId("legend-canvas-pro"), normalizeSoftwareId("legend-canvas"));
  assert.equal(requestedCreatableSoftwareId({ softwareId: "legend-canvas-pro" }), "legend-canvas-pro");
});

test("D1 首次从 GitHub 导入，后续读写不再请求 GitHub", async () => {
  const originalFetch = globalThis.fetch;
  const database = createFakeD1();
  const importedStore = {
    codes: {
      "CG-D1-IMPORT": {
        productId: "legend-comic-generator",
        edition: "customer",
        softwareId: "comic-svip-pc",
        packageScope: "legend-comic-generator:comic-svip-pc",
        days: 30,
        machines: {},
        createdAt: "2026-08-17T00:00:00.000Z",
      },
    },
  };
  let githubReads = 0;
  globalThis.fetch = async () => {
    githubReads += 1;
    return Response.json({ content: Buffer.from(JSON.stringify(importedStore)).toString("base64"), sha: "github-sha" });
  };
  const env = {
    LICENSE_DB: database,
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "data",
    GITHUB_TOKEN: "test-token",
    ADMIN_TOKEN: "admin-secret",
    PRODUCT_ID: "legend-comic-generator",
    ALLOWED_ORIGINS: "https://admin.chuanqiai.xyz",
    STORE_CACHE_SECONDS: "0",
  };
  try {
    assert.equal(storageBackend(env), "cloudflare-d1");
    const imported = await readStore(env, { fresh: true });
    assert.equal(Object.keys(imported.store.codes).length, 1);
    assert.equal(imported.sha, "1");
    assert.equal(githubReads, 1);

    const createdResponse = await worker.fetch(new Request("https://license.example/api/admin/licenses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": "admin-secret", Origin: "https://admin.chuanqiai.xyz" },
      body: JSON.stringify({ softwareId: "dialogue-factory-pc", plan: "month", count: 1 }),
    }), env);
    assert.equal(createdResponse.status, 200);

    const current = await readStore(env, { fresh: true });
    assert.equal(Object.keys(current.store.codes).length, 2);
    assert.equal(current.sha, "2");
    assert.equal(githubReads, 1);

    const statusResponse = await worker.fetch(new Request("https://license.example/api/admin/storage-status", {
      headers: { "X-Admin-Token": "admin-secret", Origin: "https://admin.chuanqiai.xyz" },
    }), env);
    const status = await statusResponse.json();
    assert.equal(status.backend, "cloudflare-d1");
    assert.equal(status.licenseCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
