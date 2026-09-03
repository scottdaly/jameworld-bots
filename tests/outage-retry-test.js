// Integration test for the capacity/auth retry logic in runFeatureOnce,
// exercised through the real exported runFeature() -- not a rewritten copy
// of the logic -- against a real local git repo so prepareWorkspace's clone
// is genuine. answer() is mocked to throw the shapes answerWithAnthropic now
// throws (capacity/auth/other), which is the actual contract change; the SDK
// call itself can't be exercised without real credentials, so that half is
// verified by reading, this half by running.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(os.tmpdir(), "toaster-outage-test-" + Date.now());
const bare = path.join(root, "repo.git");
const seed = path.join(root, "seed");
fs.mkdirSync(bare, { recursive: true });
fs.mkdirSync(seed, { recursive: true });
function git(cwd, ...args) {
  return cp.execFileSync("git", args, { cwd, encoding: "utf8" });
}
git(root, "init", "--bare", "-q", bare);
git(seed, "init", "-q", "-b", "main");
git(seed, "config", "user.email", "t@t");
git(seed, "config", "user.name", "t");
fs.writeFileSync(path.join(seed, "main.c"), "int main(){return 0;}\n");
git(seed, "add", "-A");
git(seed, "commit", "-q", "-m", "seed");
git(seed, "remote", "add", "origin", bare);
git(seed, "push", "-q", "origin", "main");

process.env.TOASTER_REPO = bare;
process.env.TOASTER_MAX_ATTEMPTS = "1";     // build-fix retries irrelevant here
const { runFeature } = require("../toaster-feature.js");
const { CAPACITY_RETRY_DELAYS_MS } = require("../error-classify.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

function baseOpts(workDir, answer) {
  return {
    request: "make the sky purple", workDir, answer,
    systemPrompt: "s", model: "claude-opus-5", maxTurns: 200,
  };
}

(async () => {
  // -- A: an auth error fails fast, no retry, no wait --------------------
  {
    let calls = 0;
    const workDir = path.join(root, "a");
    const t0 = Date.now();
    const r = await runFeature(baseOpts(workDir, async () => {
      calls++;
      throw new Error("401 authentication_error: invalid x-api-key");
    }));
    const ms = Date.now() - t0;
    check("auth error: answer() called exactly once (no retry)", calls === 1, `calls=${calls}`);
    check("auth error: returns immediately, no backoff wait", ms < 3000, `${ms}ms`);
    check("auth error: message names the credential, not a generic error",
      r.text.includes("CLAUDE_CODE_OAUTH_TOKEN") && r.text.includes("Anthropic"), r.text);
    check("auth error: ok is false", r.ok === false);
  }

  // -- B: a capacity error retries and then succeeds ----------------------
  {
    let calls = 0;
    let sawRetryMessage = null;
    const workDir = path.join(root, "b");
    const r = await runFeature(Object.assign(
      baseOpts(workDir, async () => {
        calls++;
        if (calls === 1) throw new Error("Overloaded: 529 upstream error");
        return { text: "already like that, nothing to change", turns: 3, status: "success" };
      }),
      { onProgress: (s) => { if (/cucking/.test(s)) sawRetryMessage = s; } }
    ));
    check("capacity error: retried once then succeeded", calls === 2, `calls=${calls}`);
    check("capacity error: the retry placeholder was shown and named Anthropic",
      !!sawRetryMessage && sawRetryMessage.includes("Anthropic"), String(sawRetryMessage));
    check("capacity error: job continues past the retry (reports 'nothing to change', not a failure)",
      r.text.includes("already like that"), r.text);
  }

  // -- C: capacity error on every attempt exhausts and reports honestly ---
  {
    let calls = 0;
    const workDir = path.join(root, "c");
    const t0 = Date.now();
    const r = await runFeature(baseOpts(workDir, async () => {
      calls++;
      throw new Error("503 Service Unavailable (overloaded)");
    }));
    const ms = Date.now() - t0;
    const expectedCalls = 1 + CAPACITY_RETRY_DELAYS_MS.length;
    check("capacity exhausted: answer() called once per attempt plus each retry",
      calls === expectedCalls, `calls=${calls}, expected=${expectedCalls}`);
    const expectedWait = CAPACITY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    check("capacity exhausted: actually waited through the full backoff curve",
      ms >= expectedWait - 500, `${ms}ms, expected >= ${expectedWait}ms`);
    check("capacity exhausted: final message says Anthropic, not Google",
      r.text.includes("Anthropic") && r.text.includes("still cucking"), r.text);
    check("capacity exhausted: ok is false", r.ok === false);
  }

  // -- D: an unrelated error is reported honestly, no retry, no misattribution
  {
    let calls = 0;
    const workDir = path.join(root, "d");
    const r = await runFeature(baseOpts(workDir, async () => {
      calls++;
      throw new Error("SDK internal assertion failed: unexpected token");
    }));
    check("unrelated error: no retry", calls === 1, `calls=${calls}`);
    check("unrelated error: reported honestly, not as 'nothing to change'",
      r.text.includes("errored out") && r.text.includes("unexpected token"), r.text);
    check("unrelated error: does not fall back to the capacity or auth message",
      !r.text.includes("cucking") && !r.text.includes("yeeted"), r.text);
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("HARNESS ERROR:", (e && e.stack) || e);
  process.exitCode = 1;
});
