// Run me: node tests/planner-test.js
// Needs only Node and git on PATH.
//
// The epic planner used to run in an empty directory and, handed a vague
// request, planned a from-scratch game for a repo that already holds one
// (job 244). This drives the real exported planIncrements() against a real
// local bare repo and a mocked answer(), and checks that what the planner is
// given is a genuine checkout of that repo, that it is told not to wipe it,
// and that the checkout is gone again afterwards.
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(os.tmpdir(), "toaster-planner-test-" + Date.now());
const bare = path.join(root, "repo.git");
const seed = path.join(root, "seed");
fs.mkdirSync(bare, { recursive: true });
fs.mkdirSync(seed, { recursive: true });
function git(cwd, ...args) {
  return cp.execFileSync("git", args, { cwd, encoding: "utf8" });
}
git(root, "init", "--bare", "-q", "-b", "main", bare);  // HEAD must be main, or the clone checks out nothing
git(seed, "init", "-q", "-b", "main");
git(seed, "config", "user.email", "t@t");
git(seed, "config", "user.name", "t");
fs.writeFileSync(path.join(seed, "main.c"), "int main(){return 0;}\n");
fs.writeFileSync(path.join(seed, "CLAUDE.md"), "# Toaster City\nAn existing game.\n");
git(seed, "add", "-A");
git(seed, "commit", "-q", "-m", "seed");
git(seed, "remote", "add", "origin", bare);
git(seed, "push", "-q", "origin", "main");

process.env.TOASTER_REPO = bare;
const { planIncrements } = require("../toaster-feature.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

(async () => {
  const workDir = path.join(root, "job");
  const planDir = workDir + "-plan";
  const seen = {};

  // -- A: the planner is handed a real checkout, and told not to wipe it ----
  const r = await planIncrements({
    request: "make our game more cool and fun like city skyline",
    workDir,
    model: "claude-opus-5",
    answer: async (prompt, systemPrompt, model, onProgress, maxTurns, cwd, prepared, provider) => {
      // Everything is recorded at call time, because the directory is
      // supposed to be gone by the time the call returns.
      seen.prompt = prompt;
      seen.systemPrompt = systemPrompt;
      seen.cwd = cwd;
      seen.prepared = prepared;
      seen.provider = provider;
      seen.maxTurns = maxTurns;
      seen.files = fs.existsSync(cwd) ? fs.readdirSync(cwd).sort() : null;
      seen.claudeMd = fs.existsSync(path.join(cwd, "CLAUDE.md"))
        ? fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8") : null;
      return {
        text: JSON.stringify({ increments: [
          { title: "one", request: "add a park tile to main.c" },
          { title: "two", request: "make parks raise happiness" },
        ] }),
        turns: 3, inputTokens: 10, outputTokens: 5,
      };
    },
  });

  check("planner ran in its own plan dir, not the job's workDir",
    seen.cwd === planDir, `cwd=${seen.cwd}`);
  check("that dir was a real checkout of the repo at call time",
    Array.isArray(seen.files) && seen.files.includes("main.c") && seen.files.includes(".git"),
    JSON.stringify(seen.files));
  check("CLAUDE.md from the repo was readable there",
    typeof seen.claudeMd === "string" && seen.claudeMd.includes("Toaster City"));
  check("answer() was told the dir is prepared, so it must not wipe the clone",
    seen.prepared === true, `prepared=${seen.prepared}`);
  check("planner is routed to anthropic explicitly", seen.provider === "anthropic");
  check("prompt says the game already exists and the checkout is it",
    /existing/i.test(seen.prompt) && /working directory IS that game/.test(seen.prompt));
  check("prompt tells the planner to read CLAUDE.md before planning",
    seen.prompt.includes("CLAUDE.md"));
  check("prompt forbids a rewrite or a new build system",
    /never a/.test(seen.prompt) && /new build system/.test(seen.prompt));
  check("prompt forbids editing the throwaway checkout",
    /Do not edit any file here/.test(seen.prompt));
  check("system prompt says read, do not edit, JSON only",
    /edit nothing/.test(seen.systemPrompt) && /JSON only/.test(seen.systemPrompt));
  check("the plan came back parsed", r && r.plan && r.plan.length === 2,
    JSON.stringify(r));
  check("planner usage is accounted for", r.usage.turns === 3 && r.usage.inputTokens === 10);
  check("plan dir is deleted after planning", !fs.existsSync(planDir));
  check("the job's own workDir was never created by the planner", !fs.existsSync(workDir));

  // -- B: a planner that throws still cleans up and degrades to one change --
  const r2 = await planIncrements({
    request: "x", workDir, model: "claude-opus-5",
    answer: async () => { throw new Error("529 upstream error"); },
  });
  check("planner failure degrades to no plan (one ordinary job)", r2.plan === null);
  check("plan dir is deleted even when the planner throws", !fs.existsSync(planDir));

  // -- C: an unclonable repo also degrades to one change, no crash ---------
  // REPO is read at require time, so this needs a fresh module instance.
  delete require.cache[require.resolve("../toaster-feature.js")];
  process.env.TOASTER_REPO = path.join(root, "does-not-exist.git");
  const fresh = require("../toaster-feature.js");
  let called = false;
  const r3 = await fresh.planIncrements({
    request: "x", workDir, model: "claude-opus-5",
    answer: async () => { called = true; return { text: "{}" }; },
  });
  check("unclonable repo: planner never runs on an empty floor", called === false);
  check("unclonable repo: degrades to no plan", r3.plan === null);
  check("unclonable repo: nothing left behind", !fs.existsSync(planDir));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("HARNESS ERROR:", (e && e.stack) || e);
  process.exitCode = 1;
});
