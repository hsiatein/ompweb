import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { checkNpmUpdate } = await jiti.import("./npm-update.ts");
const { checkOmpUpdate } = await jiti.import("./omp/updates.ts");
const { DISABLE_AUTOUPDATE_ENV_VAR, isUpdateDisabled } = await jiti.import("./update-policy.ts");
const {
  getSelfUpdateSupport,
  prepareSelfUpdate,
  commitSelfUpdate,
  validateCommitSelfUpdate,
} = await jiti.import("./self-update.ts");
const { GET: getAppUpdate, POST: postAppUpdate } = await jiti.import("../app/api/app-update/route.ts");
const { POST: postOmpUpdate } = await jiti.import("../app/api/omp-update/route.ts");

const ENV_VAR = DISABLE_AUTOUPDATE_ENV_VAR;


test("update opt-out accepts truthy values and leaves falsy values enabled", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), true);
  }
  for (const value of [undefined, "", "0", "false", "off", "no"]) {
    assert.equal(isUpdateDisabled({ [ENV_VAR]: value }), false);
  }
});
test("app update opt-out and source-managed runtime protection remain independent", async (t) => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  process.env[ENV_VAR] = "1";
  process.env.OMP_WEB_OMP_BIN = join(tmpdir(), "omp-web-missing-omp-for-update-policy-test");
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return Response.json({ version: "999.0.0" });
  };

  t.after(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  const appStatus = await checkNpmUpdate(true);
  assert.equal(appStatus.updatesDisabled, true);
  assert.equal(appStatus.updateAvailable, false);
  assert.equal(appStatus.availableVersion, null);

  const runtimeStatus = await checkOmpUpdate();
  assert.equal(runtimeStatus.updatesDisabled, true);
  assert.equal(runtimeStatus.updateCommand, null);

  const appResponse = await getAppUpdate(new Request("http://localhost/api/app-update?force=1"));
  assert.equal(appResponse.status, 200);
  const appBody = await appResponse.json();
  assert.equal(appBody.updatesDisabled, true);
  assert.equal(appBody.updateAvailable, false);
  assert.equal(appBody.selfUpdateSupported, false);
  assert.equal(appBody.selfUpdateStatus, undefined);

  const ompResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "check", force: true }),
  }));
  assert.equal(ompResponse.status, 200);
  assert.equal((await ompResponse.json()).reason, "source_managed");

  const appPrepareResponse = await postAppUpdate(new Request("http://localhost/api/app-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare" }),
  }));
  assert.equal(appPrepareResponse.status, 403);
  assert.equal((await appPrepareResponse.json()).code, "updates_disabled");

  const ompUpdateResponse = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update" }),
  }));
  assert.equal(ompUpdateResponse.status, 409);
  const ompUpdateBody = await ompUpdateResponse.json();
  assert.equal(ompUpdateBody.code, "runtime_source_managed");
  assert.equal(fetchCalls, 0);

  assert.equal(getSelfUpdateSupport().supported, false);
  await assert.rejects(prepareSelfUpdate("app"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
  assert.throws(() => validateCommitSelfUpdate("not-prepared"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
  assert.throws(() => commitSelfUpdate("not-prepared"), (error) => {
    assert.equal(error.code, "updates_disabled");
    assert.equal(error.httpStatus, 403);
    return true;
  });
});

test("runtime prepare and commit stay locked with app updates enabled or disabled", async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  for (const disabled of ["0", "1"]) {
    process.env[ENV_VAR] = disabled;
    await assert.rejects(prepareSelfUpdate("omp"), { code: "runtime_source_managed", httpStatus: 409 });
    assert.throws(() => validateCommitSelfUpdate("existing-attempt", "omp"), { code: "runtime_source_managed", httpStatus: 409 });
    assert.throws(() => commitSelfUpdate("existing-attempt", "omp"), { code: "runtime_source_managed", httpStatus: 409 });
    for (const body of [{ action: "update" }, { action: "commit", attemptId: "existing-attempt" }]) {
      const response = await postOmpUpdate(new Request("http://localhost/api/omp-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "runtime_source_managed");
    }
  }
});
