// Run me: node tests/cancel-flow-test.js
// Needs Node and git. Drives the real runFeature()/runFeatureEpic() against a
// real local bare repo with a mocked answer(), and checks that a cancel
// (o.isCancelled() turning true) stops the job at each checkpoint without
// retrying, pushing, or planning further -- and that a cancel that arrives
// after the agent edited does not push the branch.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(os.tmpdir(), "toaster-cancel-test-" + Date.now());
const bare = path.join(root, "repo.git");
const seed = path.join(root, "seed");
fs.mkdirSync(bare, { recursive: true });
fs.mkdirSync(seed, { recursive: true });
function git(cwd, ...args) { return cp.execFileSync("git", args, { cwd, encoding: "utf8" }); }
git(root, "init", "--bare", "-q", "-b", "main", bare);
git(seed, "init", "-q", "-b", "main");
git(seed, "config", "user.email", "t@t");
git(seed, "config", "user.name", "t");
fs.writeFileSync(path.join(seed, "main.c"), "int main(){return 0;}\n");
fs.writeFileSync(path.join(seed, "CLAUDE.md"), "# Toaster City\n");
git(seed, "add", "-A");
git(seed, "commit", "-q", "-m", "seed");
git(seed, "remote", "add", "origin", bare);
git(seed, "push", "-q", "origin", "main");

process.env.TOASTER_REPO = bare;
process.env.TOASTER_MAX_ATTEMPTS = "3";
const { runFeature, runFeatureEpic } = require("../toaster-feature.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}
// `git branch --list` marks the current branch "* main"; strip the marker.
const branches = () => git(root, "--git-dir", bare, "branch", "--list").split("*").join("").trim();

(async () => {
  // -- A: cancelled before the step starts: no clone, no model call ---------
  {
    let calls = 0;
    const workDir = path.join(root, "a");
    const r = await runFeature({
      request: "x", workDir, systemPrompt: "s", model: "claude-opus-5", maxTurns: 5,
      isCancelled: () => true,
      answer: async () => { calls++; return { text: "hi" }; },
    });
    check("A: reports cancelled, not ok", r.cancelled === true && r.ok === false, JSON.stringify(r));
    check("A: answer() never called", calls === 0);
    check("A: workDir never created", !fs.existsSync(workDir));
    check("A: says when it stopped", /before this step started/.test(r.text), r.text);
  }

  // -- B: the model call is aborted mid-edit: no retry, no push ------------
  {
    let calls = 0, cancelled = false, sawAbort = null;
    const workDir = path.join(root, "b");
    const r = await runFeature({
      request: "x", workDir, systemPrompt: "s", model: "claude-opus-5", maxTurns: 5,
      isCancelled: () => cancelled,
      abortController: new AbortController(),
      answer: async (q, sys, model, onp, mt, cwd, prepared, provider, opts) => {
        calls++;
        sawAbort = opts && opts.abortController instanceof AbortController;
        // the worker's heartbeat loses the fence while the SDK is running:
        cancelled = true;
        // ...and the SDK surfaces the abort as an error -- one that would
        // otherwise read as retryable
        throw new Error("529 Overloaded (aborted)");
      },
    });
    check("B: abort controller reaches answer()", sawAbort === true);
    check("B: answer() called once, never retried despite the 529 wording", calls === 1, `calls=${calls}`);
    check("B: reports cancelled while editing", r.cancelled === true && /while editing/.test(r.text), r.text);
    check("B: no branch was pushed", branches() === "main", branches());
  }

  // -- C: the agent finished editing, then the cancel lands before push ----
  {
    let cancelled = false;
    const workDir = path.join(root, "c");
    const r = await runFeature({
      request: "x", workDir, systemPrompt: "s", model: "claude-opus-5", maxTurns: 5,
      isCancelled: () => cancelled,
      answer: async (q, sys, model, onp, mt, cwd) => {
        fs.appendFileSync(path.join(cwd, "main.c"), "// edited\n");
        cancelled = true;          // cancel arrives as the agent hands back
        return { text: "edited", turns: 2 };
      },
    });
    check("C: reports cancelled before push", r.cancelled === true && /before anything was pushed/.test(r.text), r.text);
    check("C: the edit was NOT pushed as a branch", branches() === "main", branches());
    check("C: tokens still counted", r.turns === 2, `turns=${r.turns}`);
  }

  // -- D: an epic stops between steps and reports what shipped -------------
  {
    let cancelled = false, planned = 0;
    const workDir = path.join(root, "d");
    const r = await runFeatureEpic({
      request: "big", workDir, systemPrompt: "s", model: "claude-opus-5", maxTurns: 5,
      isCancelled: () => cancelled,
      answer: async (q) => {
        if (/increments/.test(q)) {
          planned++;
          return { text: JSON.stringify({ increments: [
            { title: "one", request: "step one" }, { title: "two", request: "step two" } ] }) };
        }
        // step one's agent runs; the cancel lands during it
        cancelled = true;
        throw new Error("aborted");
      },
    });
    check("D: planned once", planned === 1);
    check("D: epic reports cancelled", r.cancelled === true, JSON.stringify(r));
    check("D: names the step that was cut short", /\*\*one\*\*/.test(r.text), r.text);
    check("D: not ok, since nothing shipped", r.ok === false);
    check("D: nothing pushed", branches() === "main", branches());
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("HARNESS ERROR:", (e && e.stack) || e);
  process.exitCode = 1;
});
