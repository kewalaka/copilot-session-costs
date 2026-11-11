import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION, createUpdateChecker, newerVersion } from "../updates.mjs";

const release = (tag_name) => ({ ok: true, status: 200, json: async () => ({ tag_name, draft: false, prerelease: false }) });

test("compares numeric stable versions, not strings, and rejects unsafe tags", () => {
  assert.equal(newerVersion("v0.10.0", "0.9.9"), true);
  assert.equal(newerVersion("v1.0.0", "0.99.99"), true);
  assert.equal(newerVersion("v0.1.0", "0.1.0"), false);
  assert.equal(newerVersion("v0.0.9", "0.1.0"), false);
  for (const tag of ["v0.2.0-beta.1", "v01.2.3", "../../other", "v0.2.0\n"]) {
    assert.throws(() => newerVersion(tag, "0.1.0"));
  }
});

test("coalesces and caches checks, with canonical release and installation links", async () => {
  let time = 0, requests = 0;
  const checker = createUpdateChecker({
    version: "0.1.0", now: () => time,
    fetchRelease: async (url, options) => {
      requests++;
      assert.equal(url, "https://api.github.com/repos/kewalaka/copilot-session-costs/releases/latest");
      assert.equal(options.headers.Authorization, undefined);
      assert.ok(options.signal);
      return release("v0.2.0");
    },
  });
  const [first, second] = await Promise.all([checker.check(), checker.check()]);
  assert.equal(requests, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.update, {
    version: "0.2.0",
    notesUrl: "https://github.com/kewalaka/copilot-session-costs/releases/tag/v0.2.0",
    installUrl: "https://github.com/kewalaka/copilot-session-costs/tree/v0.2.0",
  });
  await checker.check();
  assert.equal(requests, 1);
  time += 3600000;
  await checker.check();
  assert.equal(requests, 2);
});

test("does not offer equal, older, or absent releases", async () => {
  for (const response of [release("v0.1.0"), release("v0.0.9"), { status: 404 }]) {
    const status = await createUpdateChecker({ version: "0.1.0", fetchRelease: async () => response }).check();
    assert.equal(status.update, null);
    assert.equal(status.error, null);
  }
});

test("reports network, rate limit, and malformed release errors and retries after five minutes", async () => {
  for (const result of [
    () => { throw new Error("offline"); },
    () => ({ status: 403, ok: false }),
    () => release("not-a-version"),
    () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v0.2.0", draft: false, prerelease: true }) }),
  ]) {
    let time = 0, requests = 0;
    const checker = createUpdateChecker({
      version: "0.1.0", now: () => time,
      fetchRelease: () => { requests++; return result(); },
    });
    const status = await checker.check();
    assert.equal(status.update, null);
    assert.match(status.error, /Update check failed/);
    await checker.check();
    assert.equal(requests, 1);
    time += 300000;
    await checker.check();
    assert.equal(requests, 2);
  }
});

test("bundled version matches the release-please manifest and is the configured version file", () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const config = JSON.parse(read("release-please-config.json")).packages["."];
  assert.equal(config["release-type"], "simple");
  assert.equal(config["version-file"], "version.txt");
  assert.equal(VERSION, JSON.parse(read(".release-please-manifest.json"))["."]);
});
