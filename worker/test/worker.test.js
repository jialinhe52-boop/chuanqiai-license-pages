import test from "node:test";
import assert from "node:assert/strict";
import worker, { normalizeSoftwareId, requestedCreatableSoftwareId, stableStringify } from "../src/index.js";

function pem(label, bytes) {
  const body = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
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
