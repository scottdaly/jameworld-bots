// Run me: node tests/image-attachment-test.js
// Needs only Node and curl on PATH -- no Postgres, no network beyond loopback.
//
// Exercises saveImageAttachments end to end through the exported
// stashAttachments() entry point, against a real local HTTP server standing
// in for Discord's CDN, using the real curl the shipped code shells out to.
process.env.TOASTER_MAX_IMAGE_BYTES = "500";   // small, so "big" is trivial to trigger
process.env.TOASTER_MAX_IMAGES = "4";          // room for both bad ones plus two good, below

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stashAttachments } = require("../toaster-feature.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

const GOOD = Buffer.from("not really a png but nothing parses it, only measures it");
const BIG = Buffer.alloc(600, 1);  // exceeds the 500-byte cap above

// Every request is logged so the test can prove rejection actually ran,
// not merely that a name is absent from the result -- absence alone does
// not distinguish "downloaded and rejected" from "never even requested",
// which is exactly the gap a slice-before-validate bug would hide.
const requested = [];
const server = http.createServer((req, res) => {
  requested.push(req.url);
  if (req.url === "/good1.png") return res.end(GOOD);
  if (req.url === "/good2.png") return res.end(GOOD);
  if (req.url === "/good3.png") return res.end(GOOD);   // to prove the cap trims it
  if (req.url === "/big.png") return res.end(BIG);
  if (req.url === "/gone.png") { res.statusCode = 404; return res.end("not found"); }
  res.statusCode = 500; res.end("?");
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const workDir = path.join(os.tmpdir(), "toaster-imgtest-" + Date.now());

  // The bad ones go FIRST and within the cap (4), so validation actually
  // runs on them instead of them being sliced off before a download is ever
  // attempted -- which is what let the previous ordering pass without really
  // exercising rejection at all. good3 alone sits past the cap, to prove
  // trimming independently of validation.
  const atts = [
    // No claimed size: saveImageAttachments rejects on the CLAIMED size
    // first, without downloading, when the caller supplies one that already
    // exceeds the cap -- a real and separate check, but not the one this
    // case means to exercise. Omitting it forces the download to actually
    // happen, so this hits the post-download byte-count check instead.
    { name: "big.png", url: `${base}/big.png`, contentType: "image/png" },
    { name: "gone.png", url: `${base}/gone.png`, size: 10, contentType: "image/png" },
    { name: "good1.png", url: `${base}/good1.png`, size: GOOD.length, contentType: "image/png" },
    { name: "good2.png", url: `${base}/good2.png`, size: GOOD.length, contentType: "image/png" },
    { name: "good3.png", url: `${base}/good3.png`, size: GOOD.length, contentType: "image/png" }, // past cap=4
    { name: "notes.txt", url: `${base}/good1.png`, size: 4, contentType: "text/plain" },
  ];

  const stash = await stashAttachments(workDir, atts);
  check("stashAttachments returns an images array", stash && Array.isArray(stash.images),
    JSON.stringify(stash));
  check("exactly the two good images within the cap were kept",
    stash.images.length === 2, `got ${stash.images && stash.images.length}`);
  check("no audio stash when nothing audio was attached", stash.audio === null);
  check("the oversize image was actually downloaded and THEN rejected on real bytes, not just absent",
    requested.includes("/big.png"), requested.join(","));
  check("the 404 was actually requested and THEN rejected, not just absent",
    requested.includes("/gone.png"), requested.join(","));
  check("the image past the count cap was never requested at all",
    !requested.includes("/good3.png"), requested.join(","));

  for (const s of stash.images) {
    check(`kept file exists on disk: ${s.name}`, fs.existsSync(s.path));
    check(`kept file has the right bytes: ${s.name}`,
      fs.readFileSync(s.path).equals(GOOD));
  }
  check("the non-image attachment was never downloaded",
    !stash.images.some((s) => s.name === "notes.txt"));
  check("the over-size image was rejected, not kept",
    !stash.images.some((s) => s.name === "big.png"));
  check("the 404 was rejected, not kept",
    !stash.images.some((s) => s.name === "gone.png"));

  const dir = workDir + ".images";
  const onDisk = fs.readdirSync(dir);
  check("exactly as many files on disk as were kept",
    onDisk.length === stash.images.length, JSON.stringify(onDisk));

  // -- the server going away must fail closed, not crash or return a wrong
  //    file. stashAttachments always fetches fresh (it has no stash param --
  //    that reuse branch lives one layer down, in saveImageAttachments, and
  //    is driven by runFeature via o.imageStash on a redo/re-claim; that path
  //    needs a real git clone to exercise, out of reach of this local test).
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  const stash2 = await stashAttachments(workDir, atts);
  check("a dead server yields no images, not a crash or a stale file",
    !stash2 || !stash2.images || stash2.images.length === 0);

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("HARNESS ERROR:", (e && e.stack) || e);
  process.exitCode = 1;
}).finally(() => { try { server.close(); } catch {} });
