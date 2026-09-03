"use strict";
/**
 * Toaster City feature mode.
 *
 * A friend asks for a change in Discord; an agent edits the C, pushes a branch,
 * and the droplet builds and publishes it. This module owns everything after
 * "the agent finished editing" -- commit, push, deploy, retry, report.
 *
 * Two rules shape the design:
 *
 *   1. Ambitious requests are the point. Turn limits are generous and there is
 *      no wall-clock kill on the agent itself.
 *   2. It must ALWAYS report back. Every path through this module returns a
 *      message for the channel -- success, failure, turn exhaustion, timeout,
 *      or an exception. Silence is the one unacceptable outcome.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = process.env.TOASTER_REPO || "github-push:scottdaly/toaster-city.git";
const DEPLOY_HOST = process.env.TOASTER_DEPLOY_HOST || "toaster-deploy";
const SITE_URL = process.env.TOASTER_SITE_URL || "https://city.rsdaly.com";

// Build attempts, not agent turns. If the gates reject the change we hand the
// compiler error back and let it try again.
const MAX_BUILD_ATTEMPTS = Number(process.env.TOASTER_MAX_ATTEMPTS || 3);

// How many times a job may start over because someone else's change landed
// first. Git can isolate two jobs but it cannot merge two different rewrites of
// the same function -- so when the rebase conflicts, the fix is not a cleverer
// merge, it is doing the work again against what actually landed. One redo:
// enough to absorb a collision, not enough to loop in a busy channel.
const MAX_REDOS = Number(process.env.TOASTER_MAX_REDOS || 1);

// Audio attachments. Binaries live in the repo forever, so cap the size and
// keep exactly one track -- the page declares a <source> per format and plays
// whichever is present.
const MAX_AUDIO_BYTES = Number(process.env.TOASTER_MAX_AUDIO_BYTES || 8 * 1024 * 1024);
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a)$/i;

// Generous, but not infinite. An SSH that hangs forever would wedge the job and
// produce no reply at all, which is the one thing we refuse to do.
const DEPLOY_TIMEOUT_MS = Number(process.env.TOASTER_DEPLOY_TIMEOUT_MS || 15 * 60 * 1000);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          timedOut: err?.killed === true || err?.signal === "SIGTERM",
          stdout: stdout || "",
          stderr: stderr || "",
        })
    );
  });
}

const git = (cwd, ...args) => run("git", args, { cwd });

function slugify(text) {
  return (
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "change"
  );
}

/** Trim compiler noise down to something a person can read in Discord. */
function firstErrors(text, n = 6) {
  const lines = (text || "").split("\n").filter((l) => /error|Error|fatal/.test(l));
  const picked = lines.slice(0, n).join("\n");
  return picked.length > 1200 ? picked.slice(0, 1200) + "\n…" : picked;
}

/**
 * Clone into workDir and cut a branch. Returns the branch name.
 * The caller passes prepared=true to answer() so the SDK doesn't wipe this.
 */
async function prepareWorkspace(workDir, request) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const clone = await run("git", ["clone", "--quiet", REPO, workDir]);
  if (!clone.ok) throw new Error("could not clone the repo: " + clone.stderr.trim());

  const branch = `feat/${slugify(request)}-${Date.now().toString(36)}`;
  const co = await git(workDir, "checkout", "-q", "-b", branch);
  if (!co.ok) throw new Error("could not create a branch: " + co.stderr.trim());

  await git(workDir, "config", "user.email", "data-boy@jameworld");
  await git(workDir, "config", "user.name", "Data Boy");
  return branch;
}

/**
 * Save an attached audio file into the checkout as the background music track.
 *
 * Discord CDN links expire, so this has to happen now rather than being handed
 * to the agent as a URL. Exactly one track is kept: the previous one is cleared
 * first, otherwise an old music.mp3 would keep winning over a new music.ogg.
 */
async function saveAudioAttachment(workDir, attachments) {
  for (const a of attachments || []) {
    const name = a.name || "";
    const isAudio = AUDIO_EXT.test(name) || /^audio\//.test(a.contentType || "");
    if (!isAudio) continue;

    if (a.size && a.size > MAX_AUDIO_BYTES) {
      return {
        skipped: `${name} is ${(a.size / 1048576).toFixed(1)}MB and the limit is ` +
          `${(MAX_AUDIO_BYTES / 1048576).toFixed(0)}MB`,
      };
    }
    const ext = (name.match(AUDIO_EXT) || [".mp3"])[0].toLowerCase();
    const dir = path.join(workDir, "web", "audio");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "music" + ext);

    const r = await run("curl", ["-sSL", "--max-time", "180", "-o", dest, a.url]);
    const ok = r.ok && fs.existsSync(dest) && fs.statSync(dest).size > 0;
    if (!ok) return { skipped: `I could not download ${name}` };
    console.log(`[toaster] saved audio ${name} -> web/audio/music${ext}`);
    return { saved: name, rel: "web/audio/music" + ext };
  }
  return {};
}

async function hasChanges(workDir) {
  const s = await git(workDir, "status", "--porcelain");
  return s.stdout.trim().length > 0;
}

async function commitAndPush(workDir, branch, request, note) {
  await git(workDir, "add", "-A");
  const msg = `${request}\n\n${note || ""}\n\nRequested in Discord, applied by Data Boy.`.trim();
  const c = await git(workDir, "commit", "-q", "-m", msg);
  if (!c.ok && !/nothing to commit/i.test(c.stdout + c.stderr)) {
    throw new Error("could not commit: " + (c.stderr || c.stdout).trim());
  }
  const p = await git(workDir, "push", "-q", "origin", branch);
  if (!p.ok) throw new Error("could not push the branch: " + p.stderr.trim());
  const sha = (await git(workDir, "rev-parse", "--short", "HEAD")).stdout.trim();
  return sha;
}

/**
 * Build a ref and run the gates WITHOUT publishing it.
 *
 * A feature branch must never become the live site. If it does and the merge
 * afterwards fails, production is left showing a tree that never reached main
 * and nothing puts it back.
 */
async function gate(ref) {
  // No leading dash: ssh would parse "--gate" as its own option and the
  // command would never reach the build host.
  return deploy(`gate ${ref}`);
}

/** Trigger the droplet build. The key on the far end can only run deploy.sh. */
async function deploy(ref) {
  const r = await run("ssh", [DEPLOY_HOST, ref], { timeout: DEPLOY_TIMEOUT_MS });
  const output = r.stdout + r.stderr;
  const last = output.trim().split("\n").slice(-1)[0] || "(no output)";
  console.log(`[toaster] deploy ${ref} -> ok=${r.ok} ${last}`);
  return { ok: r.ok, timedOut: r.timedOut, output };
}

/**
 * Fast-forward main onto what we just shipped.
 *
 * Without this every request branches from a main that never moves, so feature
 * #2 is built on a tree that does not contain feature #1 -- and deploying it
 * silently reverts #1. Merging is what makes changes accumulate.
 *
 * If main moved while we worked (someone merged first), rebase onto it and
 * redeploy, because the rebased commit is not the one we built.
 */
/**
 * Integration queue.
 *
 * The agent phase runs in parallel on purpose -- it is the slow part and each
 * job only touches its own clone. Everything from "gate" onward touches shared
 * state: origin/main and the live site. Two jobs interleaving there is how a
 * stale tree overwrites a newer one, so exactly one job is allowed through at a
 * time and the rest queue behind it.
 *
 * A promise chain rather than a real mutex because this is one Node process;
 * if the bot is ever run as more than one instance, this needs to become a
 * database advisory lock instead.
 */
let integrationChain = Promise.resolve();

function withIntegrationLock(fn) {
  const run = integrationChain.then(fn, fn);   // a failure must not jam the queue
  integrationChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Get this branch onto main, rebasing as many times as it takes.
 *
 * Holding the integration lock stops another job from moving main underneath
 * us, but something outside this process still can (a person pushing). Retry
 * rather than giving up after one attempt: losing the race once does not mean
 * the change cannot land, and dropping it there throws away a finished job.
 */
async function integrate(workDir, branch, rounds = 5) {
  for (let round = 1; round <= rounds; round++) {
    const ff = await git(workDir, "push", "origin", "HEAD:main");
    if (ff.ok) return { merged: true };

    // main moved. Rebase onto it -- but their change plus ours is a tree
    // nobody has ever built, and two changes that each compile alone can fail
    // together. Gate the combination before it is allowed near main.
    await git(workDir, "fetch", "--quiet", "origin", "main");
    const rb = await git(workDir, "rebase", "origin/main");
    if (!rb.ok) {
      await git(workDir, "rebase", "--abort");
      return {
        merged: false,
        conflict: true,     // recoverable: redo the work on top of what landed
        reason: "it conflicts with a change that landed while I was working",
      };
    }

    const push = await git(workDir, "push", "-q", "--force-with-lease", "origin", `HEAD:${branch}`);
    if (!push.ok) return { merged: false, reason: "the branch moved underneath me" };

    const g = await gate(`origin/${branch}`);
    if (!g.ok) {
      return {
        merged: false,
        reason: "combined with the change that landed while I was working, it stopped building",
      };
    }
    console.log(`[toaster] ${branch}: rebased and re-gated (round ${round})`);
  }
  return { merged: false, reason: "main kept moving faster than I could rebase onto it" };
}

/**
 * Run one feature request end to end.
 *
 * @param {object}   o
 * @param {string}   o.request       what the person asked for
 * @param {string}   o.workDir       scratch dir for this job
 * @param {function} o.answer        the bot's SDK wrapper
 * @param {string}   o.systemPrompt
 * @param {string}   o.model
 * @param {number}   o.maxTurns
 * @param {function} o.onProgress    called with short status strings for Discord
 * @returns {Promise<{text:string, ok:boolean, url?:string, preview?:string, sha?:string}>}
 */
async function runFeature(o) {
  const { request, workDir, answer, systemPrompt, model, maxTurns, onProgress } = o;
  const say = (s) => {
    try {
      onProgress?.(s);
    } catch (_) {}
  };

  // Declared before the first thing that can fail. The early catch below
  // spreads it, and a const referenced above its declaration throws a
  // ReferenceError rather than returning the failure message -- which broke
  // the report-back guarantee in exactly the path meant to guarantee it.
  const usage = { turns: 0, inputTokens: 0, outputTokens: 0 };

  let branch;
  try {
    say("cloning the repo…");
    branch = await prepareWorkspace(workDir, request);
  } catch (e) {
    return { ok: false, ...usage, text: `Couldn't get set up to make that change: ${e.message}` };
  }

  // Attachments land in the checkout before the agent starts, so it can see
  // the file rather than being told about a URL it cannot fetch.
  const audio = await saveAudioAttachment(workDir, o.attachments);

  let lastAgentText = "";
  let lastBuildError = "";

  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
    const audioNote = audio.saved
      ? `

The user attached "${audio.saved}". It is already saved in the ` +
        `checkout at ${audio.rel} and the page already plays whatever track is ` +
        `there (see web/index.html and web/boot.js) -- playback, the mute ` +
        `control and the autoplay unlock are all done. You do not need to ` +
        `change isocity.c or write any audio code. Confirm the file is in ` +
        `place and say so; only touch the page if the request asks for more ` +
        `than background music.`
      : audio.skipped
        ? `

Note: an attached audio file was not used -- ${audio.skipped}.`
        : "";

    const redoNote = o.priorConflict
      ? "\n\nNote: you already wrote this once, but another change landed first " +
        "and the two could not be merged. The checkout below is current -- their " +
        "change is already in it. Implement the request again on top of what is " +
        "there now rather than assuming your earlier version."
      : "";

    const prompt =
      attempt === 1
        ? request + audioNote + redoNote
        : `Your last change did not build. Fix it.\n\nThe request was:\n${request}\n\n` +
          `The build failed with:\n\`\`\`\n${lastBuildError}\n\`\`\`\n\n` +
          `The working tree still has your edits. Correct them.`;

    say(attempt === 1 ? "editing the code…" : `build failed — fixing (attempt ${attempt})…`);

    let res;
    try {
      // prepared=true keeps our checkout; "anthropic" forces the Agent SDK
      // path, which has the file-editing tools this job needs.
      res = await answer(prompt, systemPrompt, model, null, maxTurns, workDir, true, "anthropic");
    } catch (e) {
      return {
        ok: false,
        ...usage,
        text: `The agent errored out while editing: ${e.message}. Nothing was deployed.`,
      };
    }

    usage.turns += res?.turns || 0;
    usage.inputTokens += res?.inputTokens || 0;
    usage.outputTokens += res?.outputTokens || 0;
    lastAgentText = (res?.text || lastAgentText || "").trim();

    // Turn exhaustion is not a reason to go quiet. If it left something
    // behind, the gates decide whether it is shippable.
    const exhausted = res?.status === "error_max_turns";

    if (!(await hasChanges(workDir))) {
      return {
        ok: false,
        ...usage,
        text:
          lastAgentText ||
          (exhausted
            ? "I ran out of turns before changing anything. Try asking for something smaller."
            : "I didn't end up changing anything."),
      };
    }

    let sha;
    try {
      say("pushing…");
      sha = await commitAndPush(workDir, branch, request, lastAgentText);
    } catch (e) {
      return { ok: false, ...usage, text: `Made the change but couldn't push it: ${e.message}` };
    }

    // Everything from here to publication touches shared state -- the shared
    // build checkout, origin/main, and the live symlink. One job at a time.
    say("building...");
    const outcome = await withIntegrationLock(async () => {
      // Prove it builds, but publish nothing. Publishing a branch and merging
      // afterwards is how production ends up showing a tree that never
      // reached main.
      const g = await gate(`origin/${branch}`);
      if (!g.ok) return { stage: "gate", output: g.output, timedOut: g.timedOut };

      say("merging...");
      const m = await integrate(workDir, branch);
      if (!m.merged) return { stage: "merge", reason: m.reason, conflict: !!m.conflict };

      // Publish main itself, so the live site equals main by construction
      // rather than by assuming a branch ref resolved to what we think it did.
      say("publishing...");
      const pub = await deploy("origin/main");
      if (!pub.ok) return { stage: "publish" };

      // Grab the frame before releasing the lock. preview.png is read through
      // the mutable `current` symlink, so a job publishing between our deploy
      // and this fetch would hand the asker a picture of someone else's
      // feature. Inside the lock, nothing can move underneath us.
      await run(
        "curl",
        ["-sS", "-o", path.join(workDir, "preview.png"), `${SITE_URL}/preview.png?t=${Date.now()}`],
        { timeout: 60_000 }
      );
      return { stage: "done" };
    });

    // Someone else landed while this was being written. Do the work again on
    // top of theirs rather than handing back a branch and asking a person to
    // retype the request -- that re-ask is exactly what would happen next, and
    // prepareWorkspace clones main fresh, so the redo starts from their change.
    if (outcome.stage === "merge" && outcome.conflict && (o.redo || 0) < MAX_REDOS) {
      say("someone landed first - rebuilding on top of their change...");
      console.log(`[toaster] ${branch}: rebasing conflicted, redoing against new main`);
      const again = await runFeature(
        Object.assign({}, o, { redo: (o.redo || 0) + 1, priorConflict: outcome.reason })
      );
      // The first attempt's tokens were still spent; do not report them as free.
      return Object.assign({}, again, {
        turns: (again.turns || 0) + usage.turns,
        inputTokens: (again.inputTokens || 0) + usage.inputTokens,
        outputTokens: (again.outputTokens || 0) + usage.outputTokens,
      });
    }

    if (outcome.stage === "merge") {
      // Nothing was published, so the site is untouched and still matches main.
      return {
        ok: false,
        ...usage,
        branch,
        merged: false,
        // Outcome first. Leading with the agent's write-up made a failure read
        // as a success: it described the finished feature in the present tense,
        // then admitted at the end that none of it shipped.
        text:
          `**Not shipped.** I could not merge it -- ${outcome.reason}. The site is unchanged.` +
          `

Your work is saved on branch \`${branch}\`. Asking again now that main ` +
          `has moved usually just works, and beats merging it by hand -- it gets ` +
          `rebuilt against what actually landed.` +
          (lastAgentText ? `

-# What it had written, for reference: ${lastAgentText.split(". ")[0]}.` : ""),
      };
    }

    if (outcome.stage === "publish") {
      return {
        ok: false,
        ...usage,
        branch,
        merged: true,
        text:
          (lastAgentText || "I made the change.") +
          `

It is merged into main, but publishing it failed, so the site is still ` +
          `showing the previous version. Worth a look at the build host.`,
      };
    }

    if (outcome.stage === "done") {
      // The frame was fetched inside the lock above and left at the top of
      // workDir; collectAttachments scans that directory non-recursively for
      // images, so it rides along with the reply.
      return {
        ok: true,
        ...usage,
        sha,
        branch,
        url: SITE_URL,
        preview: `${SITE_URL}/preview.png`,
        merged: true,
        text:
          (lastAgentText || "Done.") +
          (exhausted ? `

(I hit my turn limit, but what I had built and shipped.)` : ""),
      };
    }

    if (outcome.timedOut) {
      return {
        ok: false,
        ...usage,
        branch,
        text:
          `The build ran past ${Math.round(DEPLOY_TIMEOUT_MS / 60000)} minutes and I stopped ` +
          `waiting. The branch \`${branch}\` is pushed if you want to look.`,
      };
    }

    // Only a gate failure carries build output; the other stages return early.
    const buildOut = outcome.output || "";
    lastBuildError = firstErrors(buildOut) || buildOut.slice(-1200);
    if (attempt === MAX_BUILD_ATTEMPTS) {
      return {
        ok: false,
        ...usage,
        branch,
        text:
          `I couldn't get that to build after ${MAX_BUILD_ATTEMPTS} tries. The site is unchanged.\n` +
          `Last error:\n\`\`\`\n${lastBuildError}\n\`\`\`\nBranch \`${branch}\` is pushed.`,
      };
    }
  }

  // Unreachable, but never return undefined.
  return { ok: false, ...usage, text: "I gave up without a clear reason, which is a bug. Nothing shipped." };
}

/**
 * Rescue a work dir left behind by a job that was killed mid-run.
 *
 * The agent's edits live only in the working tree until the build step commits
 * them, so an interrupted job loses everything it had done. Given the work dir
 * survives (it is on a volume), push whatever is there to a rescue branch so the
 * effort is recoverable instead of thrown away.
 */
async function salvageWorkDir(workDir, label) {
  try {
    if (!fs.existsSync(path.join(workDir, ".git"))) return null;
    const status = await git(workDir, "status", "--porcelain");
    if (!status.stdout.trim()) return null;          // nothing uncommitted to save

    const branch = `rescue/${label}`;
    await git(workDir, "config", "user.email", "data-boy@jameworld");
    await git(workDir, "config", "user.name", "Data Boy");
    await git(workDir, "checkout", "-q", "-B", branch);
    await git(workDir, "add", "-A");
    const c = await git(workDir, "commit", "-q", "-m",
      "salvaged from a job interrupted by a restart");
    if (!c.ok) return null;
    const p = await git(workDir, "push", "-q", "-f", "origin", branch);
    if (!p.ok) return null;
    console.log(`[toaster] salvaged interrupted work to ${branch}`);
    return { branch };
  } catch (err) {
    console.warn(`[toaster] salvage failed: ${err.message}`);
    return null;
  }
}

/* =======================================================================
 *  Large requests, delivered in pieces
 *
 *  A big ask ("add everything from Cities: Skylines") currently succeeds or
 *  fails whole: one run, one gate, all or nothing. Split into increments, a
 *  later failure still leaves the earlier ones shipped and playable, each diff
 *  is small enough to rarely conflict, and the integration lock is released
 *  between them so nobody else is stuck behind an epic.
 *
 *  The planner decides how many pieces. It does NOT decide the limits: every
 *  bound below is enforced here, because the runaway case -- an unbounded plan
 *  multiplied by three build attempts at full turn budget -- is the one failure
 *  that is both expensive and silent.
 * ===================================================================== */

const MAX_INCREMENTS = Number(process.env.TOASTER_MAX_INCREMENTS || 4);
const EPIC_TURN_BUDGET = Number(process.env.TOASTER_EPIC_TURNS || 500);
const EPIC_MS_BUDGET = Number(process.env.TOASTER_EPIC_MS || 45 * 60 * 1000);

const PLAN_PROMPT = [
  "Break the request below into increments that each leave the game fully",
  "playable on their own, and that build on each other in order.",
  "",
  "Rules:",
  "- If the request fits in ONE change, return exactly one increment. Most do.",
  "- Never more than " + MAX_INCREMENTS + ".",
  "- Each increment must stand alone: no half-wired UI, no save-format change",
  "  before the code that reads it, nothing that leaves the game worse than",
  "  before if the next increment never happens.",
  "- Order them so each one only relies on what came before.",
  "",
  "Reply with JSON only, no prose and no code fence:",
  '{"increments":[{"title":"short label","request":"a full standalone request"}]}',
  "",
  "The `request` field is handed verbatim to whoever implements it, so it must",
  "make sense with no other context.",
].join("\n");

/** Ask for a plan. Any doubt at all falls back to a single increment. */
async function planIncrements(o) {
  const res = await o.answer(
    PLAN_PROMPT + "\n\nThe request:\n" + o.request,
    "You are planning work on a small C game. Reply with JSON only.",
    o.model,
    null,
    12,                      // planning is cheap; it must not become the work
    o.workDir + "-plan",     // its own dir, so stray edits cannot leak into the build
    false,
    // Same provider as the work itself. Without this the planner inherits the
    // global MODEL_PROVIDER (gemini-api here) while o.model is an Anthropic
    // name, and the request goes to Google asking for a Claude model.
    "anthropic"
  );
  const usage = {
    turns: res && res.turns ? res.turns : 0,
    inputTokens: res && res.inputTokens ? res.inputTokens : 0,
    outputTokens: res && res.outputTokens ? res.outputTokens : 0,
  };
  try {
    const raw = String((res && res.text) || "");
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    const list = Array.isArray(parsed.increments) ? parsed.increments : [];
    const clean = list
      .filter(function (x) { return x && typeof x.request === "string" && x.request.trim(); })
      .slice(0, MAX_INCREMENTS)
      .map(function (x, i) {
        return {
          title: String(x.title || "step " + (i + 1)).slice(0, 60),
          request: x.request.trim().slice(0, 2000),
        };
      });
    return { plan: clean.length ? clean : null, usage };
  } catch (err) {
    // A malformed plan is not permission to improvise; do the request as asked.
    console.warn("[toaster] plan unparseable, treating as one change:", err.message);
    return { plan: null, usage };
  }
}

/**
 * Run a request, in one piece or several.
 *
 * @param {function} [o.onIncrement] awaited between increments, so the preview
 *        is delivered before the next clone wipes the work dir.
 */
async function runFeatureEpic(o) {
  const started = Date.now();
  const total = { turns: 0, inputTokens: 0, outputTokens: 0 };
  const add = function (r) {
    total.turns += (r && r.turns) || 0;
    total.inputTokens += (r && r.inputTokens) || 0;
    total.outputTokens += (r && r.outputTokens) || 0;
  };

  const planned = await planIncrements(o);
  add(planned.usage);
  const plan = planned.plan;

  // One increment means one ordinary job -- and it runs the ORIGINAL wording,
  // not the planner's paraphrase, which can quietly drop detail.
  if (!plan || plan.length <= 1) {
    const r = await runFeature(o);
    add(r);
    return Object.assign({}, r, total);
  }

  console.log("[toaster] plan: " + plan.map(function (p) { return p.title; }).join(" -> "));
  const shipped = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const left = EPIC_TURN_BUDGET - total.turns;
    const elapsed = Date.now() - started;

    if (left <= 0 || elapsed > EPIC_MS_BUDGET) {
      return Object.assign({
        ok: shipped.length > 0,
        // The step's own message already leads with the outcome, so do not
        // prefix it with "Nothing landed" -- that read as a contradiction next
        // to an agent write-up describing the feature as finished.
        text:
          (shipped.length
            ? summarise(shipped, plan) + "\n\nThen **" + step.title + "** did not land.\n\n"
            : "**" + step.title + "** did not land.\n\n") +
          r.text +
          "\n\nI stopped there rather than building the rest on top of it.",
      }, total);
    }

    // callers pass onProgress, not say -- this drives the placeholder text
    if (typeof o.onProgress === "function") {
      try { o.onProgress("step " + (i + 1) + " of " + plan.length + ": " + step.title); }
      catch (e) {}
    }
    const r = await runFeature(Object.assign({}, o, { request: step.request }));
    add(r);

    if (!r.ok) {
      // Stop rather than build the next step on something that did not land.
      // A merged-but-unpublished step is worse still: main and the site
      // disagree, and continuing would pile changes on top of that.
      return Object.assign({
        ok: shipped.length > 0,
        branch: r.branch,
        text: summarise(shipped, plan) +
          "\n\n**" + step.title + "** did not land: " + r.text +
          "\n\nI stopped there rather than building the rest on top of it.",
      }, total);
    }

    shipped.push(step.title);
    if (i < plan.length - 1 && typeof o.onIncrement === "function") {
      try {
        await o.onIncrement({
          title: step.title,
          index: i + 1,
          of: plan.length,
          text: r.text,
          preview: path.join(o.workDir, "preview.png"),
        });
      } catch (err) {
        console.warn("[toaster] interim post failed:", err.message);
      }
    }
  }

  return Object.assign({ ok: true, url: SITE_URL, text: summarise(shipped, plan) }, total);
}

function summarise(shipped, plan) {
  if (!shipped.length) return "Nothing landed.";
  return "Shipped " + shipped.length + " of " + plan.length + ": " +
    shipped.map(function (s) { return "**" + s + "**"; }).join(", ") + ".";
}

module.exports = { runFeature, runFeatureEpic, salvageWorkDir, SITE_URL };
