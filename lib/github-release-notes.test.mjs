import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getGitHubReleaseNotes } = await jiti.import("./github-release-notes.ts");

test("release notes resolve the fork's GitHub source release", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/kaanzapkinus/ompweb-plus/releases/tags/v0.5.2-plus.1");
    assert.equal(options.headers["User-Agent"], "@kaanzapkinus/ompweb-plus");
    return Response.json({ tag_name: "v0.5.2-plus.1", draft: false, body: "Source release", html_url: "https://github.com/kaanzapkinus/ompweb-plus/releases/tag/v0.5.2-plus.1" });
  };
  assert.deepEqual(await getGitHubReleaseNotes("0.5.2-plus.1"), {
    version: "0.5.2-plus.1", body: "Source release", htmlUrl: "https://github.com/kaanzapkinus/ompweb-plus/releases/tag/v0.5.2-plus.1",
  });
});
