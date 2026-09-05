// Run me: node tests/publish-verify-test.js
// Needs only Node, curl and git on PATH -- no Postgres, no network beyond loopback.
//
// The publish step used to believe the ssh exit status. It cannot: the answer
// crosses two SSH hops and either can drop it after the release symlink has
// already been swapped, so a non-zero exit means "I did not hear", not "it did
// not happen". On 2026-09-05 that produced a merged-but-unpublished main and a
// report that told a person to go and look for themselves.
//
// isLive() is what replaced it: ask the site which commit it is serving. This
// exercises it against a real local HTTP server standing in for the site and a
// real git repo for the ancestry question, using the real curl and real git the
// shipped code shells out to.

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

// What /version.txt hands back on the next request. The tests move it around.
let served = { status: 200, body: "" };
const server = http.createServer((req, res) => {
  // The caller appends a cache-buster; a static file server ignores the query,
  // so this one must too, or every check would 404.
  if (!req.url.startsWith("/version.txt")) { res.statusCode = 404; return res.end("no"); }
  res.statusCode = served.status;
  res.end(served.body);
});

// A real remote, a real clone, and a real second checkout pushing to it. The
// descendant case only means anything against a clone that does NOT already
// have the commit -- which is the whole point of it -- so a single local repo
// would quietly test nothing.
const root = path.join(os.tmpdir(), "toaster-publish-verify-" + Date.now());
const origin = path.join(root, "origin.git");
const repo = path.join(root, "repo");        // the job's clone
const other = path.join(root, "other");      // somebody else, pushing on top
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.TOASTER_SITE_URL = `http://127.0.0.1:${server.address().port}`;
  // Required after the env var is set: SITE_URL is read once, at module load.
  const { liveSha, isLive } = require("../toaster-feature.js");

  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);

  // Seed the remote: one commit, then ours on top.
  const seed = path.join(root, "seed");
  fs.mkdirSync(seed);
  gitIn(seed, "init", "-q", "-b", "main");
  gitIn(seed, "config", "user.email", "t@t");
  gitIn(seed, "config", "user.name", "t");
  fs.writeFileSync(path.join(seed, "f"), "one");
  gitIn(seed, "add", "-A"); gitIn(seed, "commit", "-q", "-m", "one");
  const older = gitIn(seed, "rev-parse", "--short", "HEAD");
  fs.writeFileSync(path.join(seed, "f"), "two");
  gitIn(seed, "add", "-A"); gitIn(seed, "commit", "-q", "-m", "two");
  gitIn(seed, "remote", "add", "origin", origin);
  gitIn(seed, "push", "-q", "origin", "main");

  // The job's clone, taken before anyone else pushes -- exactly as a worker
  // clones at the start of a job.
  execFileSync("git", ["clone", "-q", origin, repo]);
  const ours = git("rev-parse", "--short", "HEAD");
  const longOurs = git("rev-parse", "HEAD");

  served = { status: 200, body: ours + "\n" };
  let r = await isLive(repo, ours);
  check("the site serving our own sha is live", r.ok && r.live === ours, JSON.stringify(r));

  // This is the 2026-09-05 failure exactly: main moved, the site did not.
  served = { status: 200, body: older + "\n" };
  r = await isLive(repo, ours);
  check("the site one commit behind is NOT live", r.ok === false && r.live === older, JSON.stringify(r));

  // Someone pushed on top of us between the deploy and this check. The site is
  // newer than we asked for and our change is still in it -- shipped, not
  // broken. The commit exists ONLY on the remote at this point, so getting this
  // right requires fetching; without that this reads as "not live" and a
  // shipped feature is reported as broken.
  fs.mkdirSync(other);
  execFileSync("git", ["clone", "-q", origin, other]);
  gitIn(other, "config", "user.email", "u@u");
  gitIn(other, "config", "user.name", "u");
  fs.writeFileSync(path.join(other, "f"), "three");
  gitIn(other, "add", "-A"); gitIn(other, "commit", "-q", "-m", "three");
  gitIn(other, "push", "-q", "origin", "main");
  const newer = gitIn(other, "rev-parse", "--short", "HEAD");
  check("precondition: the job's clone has not seen the newer commit",
    (() => {
      try {
        // stdio ignored: git writes "not a valid object name" to stderr and
        // that is the passing case, not a test failure to print.
        execFileSync("git", ["cat-file", "-e", newer + "^{commit}"], { cwd: repo, stdio: "ignore" });
        return false;
      } catch { return true; }
    })());

  served = { status: 200, body: newer + "\n" };
  r = await isLive(repo, ours);
  check("a descendant pushed by someone else counts as live",
    r.ok === true && r.live === newer, JSON.stringify(r));

  // git may abbreviate to different lengths on the two sides; the ancestry
  // check has to absorb that, because a string compare alone would not.
  served = { status: 200, body: longOurs + "\n" };
  r = await isLive(repo, ours);
  check("a longer abbreviation of the same commit counts as live", r.ok === true, JSON.stringify(r));

  // A commit the site names but this clone has never heard of cannot be shown
  // to contain our work, so it is not an answer.
  served = { status: 200, body: "0123456789abcdef0123456789abcdef01234567\n" };
  r = await isLive(repo, ours);
  check("an unknown sha is not treated as live", r.ok === false, JSON.stringify(r));

  // A proxy or error page can return 200 with any bytes at all. Only something
  // shaped like a sha is an answer; anything else must read as "no answer",
  // never as a version to compare against.
  served = { status: 200, body: "<html>502 Bad Gateway</html>" };
  r = await isLive(repo, ours);
  check("an HTML error body is not a version", r.ok === false && r.live === null, JSON.stringify(r));

  served = { status: 200, body: "" };
  check("an empty body is not a version", (await liveSha()) === null);

  served = { status: 500, body: "boom" };
  r = await isLive(repo, ours);
  check("a 5xx is not live and reports no version", r.ok === false && r.live === null, JSON.stringify(r));

  // The site being unreachable must not read as "published" -- that is the
  // whole failure this test exists to prevent.
  await new Promise((res) => server.close(res));
  r = await isLive(repo, ours);
  check("an unreachable site is not live", r.ok === false && r.live === null, JSON.stringify(r));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
