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
const MAX_REDOS = (function () {
  // Infinity and 1.5 both parse as numbers and both break the bound -- one
  // removes it, the other rounds up through it. Only a small whole count is a
  // bound at all.
  const raw = process.env.TOASTER_MAX_REDOS;
  const n = raw === undefined || raw === "" ? 1 : Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3) : 1;
})();

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
async function saveAudioAttachment(workDir, attachments, stash) {
  // A redo re-clones into a fresh workDir, so the track saved on the first
  // attempt is gone -- and the Discord URL it came from has a good chance of
  // having expired by then. Reuse the copy kept outside workDir instead of
  // letting a merge collision turn a valid music request into a failed one.
  if (stash && fs.existsSync(stash.path)) {
    const dir = path.join(workDir, "web", "audio");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(stash.path, path.join(dir, "music" + stash.ext));
    console.log("[toaster] reused stashed audio " + stash.name);
    return { saved: stash.name, rel: "web/audio/music" + stash.ext, stash: stash };
  }

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

    // --fail matters here: without it curl writes the CDN's 403/404 HTML body
    // to the file and still exits 0, and "nonempty" then calls that a track.
    const r = await run("curl", ["-sSL", "--fail", "--max-time", "180", "-o", dest, a.url]);
    const got = r.ok && fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (!got) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { skipped: `I could not download ${name}` };
    }
    // a.size above is the caller's claim about the file; this is the file that
    // actually arrived, which is the one that would go into the repo forever.
    if (got > MAX_AUDIO_BYTES) {
      fs.rmSync(dir, { recursive: true, force: true });
      return {
        skipped: `${name} came down as ${(got / 1048576).toFixed(1)}MB and the limit is ` +
          `${(MAX_AUDIO_BYTES / 1048576).toFixed(0)}MB`,
      };
    }

    // Outside workDir, so prepareWorkspace cannot wipe it; runFeature deletes
    // it once the job (including any redo) is finished with it.
    const stashPath = workDir + ".audio";
    let kept = null;
    try {
      fs.copyFileSync(dest, stashPath);
      kept = { path: stashPath, ext: ext, name: name };
    } catch (e) {
      console.warn("[toaster] could not stash audio: " + e.message);
    }
    console.log(`[toaster] saved audio ${name} -> web/audio/music${ext} (${got} bytes)`);
    return { saved: name, rel: "web/audio/music" + ext, stash: kept };
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
    // After a rebase round HEAD is a different commit than the one that was
    // pushed to the branch, so read it here rather than trusting the caller's
    // pre-integration sha -- that one names a commit no longer on main.
    if (ff.ok) {
      const h = await git(workDir, "rev-parse", "--short", "HEAD");
      return { merged: true, sha: h.ok ? h.stdout.trim() : null };
    }

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
/**
 * Wrapper whose only job is the promise this module makes to its caller: it
 * resolves, always, with a `text` somebody can be shown. Every silence this bot
 * has produced traced back to a rejection nobody was catching, so the failure
 * mode is closed here once rather than at each of the twenty return sites.
 */
async function runFeature(o) {
  const none = { turns: 0, inputTokens: 0, outputTokens: 0 };
  try {
    const r = await runFeatureOnce(o);
    if (r && typeof r.text === "string" && r.text) return r;
    console.error("[toaster] runFeature returned no text:", JSON.stringify(r));
    return Object.assign({ ok: false }, none, r || {}, {
      text: "The job finished without producing a result. Nothing shipped.",
    });
  } catch (e) {
    console.error("[toaster] runFeature threw:", (e && e.stack) || e);
    return Object.assign({ ok: false }, none, {
      text: `The job hit an unexpected error and stopped: ${(e && e.message) || e}. ` +
        "Nothing shipped.",
    });
  } finally {
    // Only the attempt that created the stash retires it; a redo is handed one
    // it does not own and whose file the outer attempt still needs afterwards.
    if (!o.audioStash) {
      try { fs.rmSync(o.workDir + ".audio", { force: true }); } catch (e) {}
    }
  }
}

async function runFeatureOnce(o) {
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
  let audio;
  try {
    audio = await saveAudioAttachment(workDir, o.attachments, o.audioStash);
  } catch (e) {
    // Outside the setup try/catch above, this used to escape runFeature
    // entirely -- a filesystem error on a music upload meant total silence.
    console.warn("[toaster] attachment save failed: " + e.message);
    audio = { skipped: `I could not save the attachment (${e.message})` };
  }

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
      res = await answer(prompt, systemPrompt, model, null, maxTurns, workDir, true, "anthropic",
                         { onActivity: o.onActivity });
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
      if (m.sha) sha = m.sha;   // a rebase rewrote it; report what landed

      // Publish main itself, so the live site equals main by construction
      // rather than by assuming a branch ref resolved to what we think it did.
      say("publishing...");
      const pub = await deploy("origin/main");
      if (!pub.ok) return { stage: "publish" };

      // Grab the frame before releasing the lock. preview.png is read through
      // the mutable `current` symlink, so a job publishing between our deploy
      // and this fetch would hand the asker a picture of someone else's
      // feature. Inside the lock, nothing can move underneath us.
      const png = path.join(workDir, "preview.png");
      const shot = await run(
        "curl",
        ["-sS", "--fail", "-o", png, `${SITE_URL}/preview.png?t=${Date.now()}`],
        { timeout: 60_000 }
      );
      const gotShot = shot.ok && fs.existsSync(png) && fs.statSync(png).size > 0;
      // A missed screenshot is not a missed feature -- it shipped either way.
      // But a truncated or HTML-bodied file must not be handed to
      // collectAttachments, which would post it as if it were the frame.
      if (!gotShot) fs.rmSync(png, { force: true });
      return { stage: "done", shot: gotShot };
    });

    // Someone else landed while this was being written. Do the work again on
    // top of theirs rather than handing back a branch and asking a person to
    // retype the request -- that re-ask is exactly what would happen next, and
    // prepareWorkspace clones main fresh, so the redo starts from their change.
    if (outcome.stage === "merge" && outcome.conflict && (o.redo || 0) < MAX_REDOS) {
      say("someone landed first - rebuilding on top of their change...");
      console.log(`[toaster] ${branch}: rebasing conflicted, redoing against new main`);
      const again = await runFeature(
        Object.assign({}, o, {
          redo: (o.redo || 0) + 1,
          priorConflict: outcome.reason,
          audioStash: audio.stash,   // the URL it came from may be dead by now
        })
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

It is merged into main, but the publish step failed or timed out. A failure ` +
          `there does not tell me whether the site picked the change up or not, ` +
          `so check ${SITE_URL} and the build host rather than assuming either.`,
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
        preview: outcome.shot ? `${SITE_URL}/preview.png` : undefined,
        merged: true,
        text:
          (lastAgentText || "Done.") +
          (exhausted ? `

(I hit my turn limit, but what I had built and shipped.)` : "") +
          (outcome.shot ? "" : `

-# The change is live; I just could not grab a screenshot of it.`),
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
  const res = await planAsk(o);
  if (!res) return { plan: null, usage: { turns: 0, inputTokens: 0, outputTokens: 0 } };
  return parsePlan(res);
}

/** The provider call on its own, so a provider outage degrades to one job. */
async function planAsk(o) {
  try {
    return await o.answer(
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
  } catch (e) {
    console.warn("[toaster] planner unavailable, treating as one change:", e.message);
    return null;
  }
}

function parsePlan(res) {
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
  try {
    return await runFeatureEpicInner(o);
  } catch (e) {
    // Same promise as runFeature: whoever asked gets an answer. The planner's
    // answer() call in particular sits outside every other catch.
    console.error("[toaster] runFeatureEpic threw:", (e && e.stack) || e);
    return {
      ok: false, turns: 0, inputTokens: 0, outputTokens: 0,
      text: `The job hit an unexpected error before it could ship anything: ` +
        `${(e && e.message) || e}.`,
    };
  }
}

async function runFeatureEpicInner(o) {
  const started = Date.now();
  const total = { turns: 0, inputTokens: 0, outputTokens: 0 };
  const add = function (r) {
    total.turns += (r && r.turns) || 0;
    total.inputTokens += (r && r.inputTokens) || 0;
    total.outputTokens += (r && r.outputTokens) || 0;
  };

  // Writing the plan down is what makes a killed job resumable: a shipped
  // increment is already merged and published, so the only thing lost in a
  // restart is the knowledge that it happened. Never let a bookkeeping
  // failure take the job with it.
  const persist = async function (state) {
    if (typeof o.persist !== "function") return;
    try { await o.persist(state); }
    catch (e) { console.warn("[toaster] could not persist job state: " + e.message); }
  };

  let plan, shipped = [], startAt = 0;
  if (o.resume && Array.isArray(o.resume.plan) && o.resume.plan.length > 1) {
    // Picking up after a restart. The increments in `shipped` are on main and
    // live; redoing them would be a second, conflicting rewrite of work that
    // already landed.
    plan = o.resume.plan;
    shipped = Array.isArray(o.resume.shipped) ? o.resume.shipped.slice() : [];
    startAt = Number(o.resume.step) || 0;
    if (!(startAt >= 0)) startAt = 0;
    if (startAt > plan.length) startAt = plan.length;
    console.log(`[toaster] resuming at step ${startAt + 1} of ${plan.length}, ` +
      `${shipped.length} already shipped`);
  } else {
    const planned = await planIncrements(o);
    add(planned.usage);
    plan = planned.plan;
  }

  // One increment means one ordinary job -- and it runs the ORIGINAL wording,
  // not the planner's paraphrase, which can quietly drop detail.
  if (!plan || plan.length <= 1) {
    const r = await runFeature(o);
    add(r);
    return Object.assign({}, r, total);
  }

  // Everything already landed before the restart; nothing left to run.
  if (startAt >= plan.length) {
    return Object.assign({ ok: shipped.length > 0, url: SITE_URL,
      text: summarise(shipped, plan) }, total);
  }

  console.log("[toaster] plan: " + plan.map(function (p) { return p.title; }).join(" -> "));
  await persist({ plan: plan, shipped: shipped, step: startAt });

  for (let i = startAt; i < plan.length; i++) {
    const step = plan[i];
    const left = EPIC_TURN_BUDGET - total.turns;
    const elapsed = Date.now() - started;

    if (left <= 0 || elapsed > EPIC_MS_BUDGET) {
      // This branch used to interpolate `r`, which is declared below it and is
      // block-scoped to this iteration -- so running out of budget threw a
      // ReferenceError instead of reporting, which is the one outcome this bot
      // is not allowed to have. There is no `r` here by construction: the step
      // being described never started.
      const why = left <= 0
        ? "the turn budget for one request was used up"
        : `the ${Math.round(EPIC_MS_BUDGET / 60000)}-minute budget for one request ran out`;
      return Object.assign({
        ok: shipped.length > 0,
        text:
          (shipped.length
            ? summarise(shipped, plan) + "\n\nThen **" + step.title + "** never started: " + why + "."
            : "**" + step.title + "** never started: " + why + ".") +
          "\n\nNothing is half-finished -- ask for the rest and I will pick up from here.",
      }, total);
    }

    // callers pass onProgress, not say -- this drives the placeholder text
    if (typeof o.onProgress === "function") {
      try { o.onProgress("step " + (i + 1) + " of " + plan.length + ": " + step.title); }
      catch (e) {}
    }
    // `left` was computed and then dropped on the floor, so every increment
    // got the full per-request allowance and the epic budget bounded nothing.
    // The step whose success was never checkpointed may in fact have landed:
    // runFeature merges and publishes before returning, and `step` only
    // advances after it returns. A crash in that gap is invisible from here,
    // so the first step after a resume is warned rather than assumed fresh.
    const firstAfterResume = i === startAt && startAt > 0 && !!o.resume;
    const r = await runFeature(Object.assign({}, o, {
      request: firstAfterResume
        ? step.request +
          "\n\nNOTE: a previous attempt at this step was interrupted, and it " +
          "may have already landed before it died. Check whether this change is " +
          "already present before making it. If it is, verify it is complete and " +
          "correct rather than doing it a second time."
        : step.request,
      maxTurns: Math.max(1, Math.min(o.maxTurns || left, left)),
    }));
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
    // Record it before the interim post: the post can fail, the increment is
    // still shipped, and a restart must not redo it.
    await persist({ plan: plan, shipped: shipped, step: i + 1 });
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

/**
 * Pull an attachment down now and leave it where a later attempt can find it.
 *
 * Discord CDN links expire. Inline, that was fine -- the job started within
 * seconds. Queued, it may sit behind an hour of other work, and by the time a
 * worker claims it the URL can be dead. The stash lives beside the work dir
 * rather than inside it, so the worker's fresh clone does not wipe it; pass
 * what this returns back as `audioStash`.
 */
async function stashAttachments(workDir, attachments) {
  if (!attachments || !attachments.length) return null;
  fs.mkdirSync(workDir, { recursive: true });
  const r = await saveAudioAttachment(workDir, attachments);
  if (r.skipped) console.warn("[toaster] attachment not stashed: " + r.skipped);
  return r.stash || null;
}

module.exports = {
  runFeature, runFeatureEpic, salvageWorkDir, stashAttachments, SITE_URL,
};
