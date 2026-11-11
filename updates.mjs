import { readFileSync } from "node:fs";

const REPO = "https://github.com/kewalaka/copilot-session-costs";
export const VERSION = readFileSync(new URL("version.txt", import.meta.url), "utf8").trim();

function parts(version) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match[0] !== version) throw new Error(`Invalid stable release version: ${version}`);
  return match.slice(1).map(BigInt);
}

export function newerVersion(latest, installed) {
  const left = parts(latest), right = parts(installed);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

export function createUpdateChecker({ fetchRelease = fetch, now = Date.now, version = VERSION } = {}) {
  parts(version);
  let expires = 0, cached, pending;
  return {
    check() {
      if (pending) return pending;
      if (cached && now() < expires) return Promise.resolve(cached);
      pending = Promise.resolve().then(async () => {
        try {
          const response = await fetchRelease("https://api.github.com/repos/kewalaka/copilot-session-costs/releases/latest", {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "copilot-session-costs" },
            signal: AbortSignal.timeout(5000),
          });
          let update = null;
          if (response.status !== 404) {
            if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
            const release = await response.json();
            if (release.draft !== false || release.prerelease !== false) throw new Error("Expected a published stable release");
            if (typeof release.tag_name !== "string") throw new Error("Release has no version tag");
            if (newerVersion(release.tag_name, version)) {
              update = {
                version: release.tag_name.replace(/^v/, ""),
                notesUrl: `${REPO}/releases/tag/${release.tag_name}`,
                installUrl: `${REPO}/tree/${release.tag_name}`,
              };
            }
          }
          cached = { currentVersion: version, update, error: null };
          expires = now() + 60 * 60 * 1000;
        } catch (error) {
          cached = { currentVersion: version, update: null, error: `Update check failed: ${error.message}` };
          expires = now() + 5 * 60 * 1000;
        } finally {
          pending = null;
        }
        return cached;
      });
      return pending;
    },
  };
}
