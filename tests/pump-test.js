// Run me: node tests/pump-test.js
// Pure scheduling test, no Postgres: workerPump with a fake claim/run.
//
// What it must prove: at most `limit` jobs run at once, a slot reopens the
// moment a job finishes (not on a poll tick), the first job always starts
// but a SECOND waits while canStartAnother() says no, and draining stops
// claims while letting what is running finish.
const { workerPump, availableMemoryMb } = require("../job-queue.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

// A queue of rows, and jobs that only finish when the test says so.
function harness(rowIds) {
  const queue = rowIds.map((id) => ({ id }));
  const running = new Map();   // id -> resolve
  const started = [];
  let maxConcurrent = 0;
  const logs = [];
  let done = false;
  const api = {
    claim: async () => queue.shift() || null,
    run: (row) => new Promise((resolve) => {
      started.push(row.id);
      running.set(row.id, resolve);
      maxConcurrent = Math.max(maxConcurrent, running.size);
    }),
    finish: (id) => { const r = running.get(id); running.delete(id); r(); },
    started, running, logs,
    get maxConcurrent() { return maxConcurrent; },
    stop: () => { done = true; },
    until: () => done,
    log: (m) => logs.push(m),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return api;
}

(async () => {
  // -- A: bounded at `limit`, slot reopens on completion --------------------
  {
    const h = harness([1, 2, 3, 4]);
    const loop = workerPump({ claim: h.claim, run: h.run, limit: 2, pollMs: 5,
      until: h.until, sleep: h.sleep, log: h.log });
    await settle();
    check("two jobs start immediately with limit 2", h.started.join(",") === "1,2", h.started.join(","));
    await new Promise((r) => setTimeout(r, 30));
    check("third does not start while two are running", h.started.length === 2, h.started.join(","));
    h.finish(1);
    await settle();
    check("finishing one lets the next claim at once", h.started.join(",") === "1,2,3", h.started.join(","));
    h.finish(2); h.finish(3);
    await settle();
    check("fourth starts once slots free", h.started.includes(4));
    check("never more than 2 at once", h.maxConcurrent === 2, `max=${h.maxConcurrent}`);
    h.finish(4);
    h.stop();
    await loop;
    check("loop ends after until() with nothing running", h.running.size === 0);
    check("startup log names the overlap", h.logs.some((m) => /starts alongside 1 other/.test(m)),
      JSON.stringify(h.logs));
  }

  // -- B: the memory guard holds the SECOND slot, never the first ----------
  {
    const h = harness([10, 11]);
    let headroom = false;
    const loop = workerPump({ claim: h.claim, run: h.run, limit: 2, pollMs: 5,
      canStartAnother: () => headroom ? true : "300MB available, a second job needs 450MB",
      until: h.until, sleep: h.sleep, log: h.log });
    await settle();
    check("first job starts regardless of headroom", h.started.join(",") === "10", h.started.join(","));
    await new Promise((r) => setTimeout(r, 40));
    check("second is held back while headroom says no", h.started.length === 1, h.started.join(","));
    check("the hold is logged once, with the reason",
      h.logs.filter((m) => /holding a free slot: 300MB/.test(m)).length === 1, JSON.stringify(h.logs));
    headroom = true;
    await new Promise((r) => setTimeout(r, 40));
    check("second starts once headroom returns", h.started.join(",") === "10,11", h.started.join(","));
    check("headroom return is logged", h.logs.some((m) => /headroom is back/.test(m)));
    h.finish(10); h.finish(11); h.stop();
    await loop;
  }

  // -- C: draining claims nothing new but lets the running job finish ------
  {
    const h = harness([20, 21]);
    let draining = false;
    const loop = workerPump({ claim: h.claim, run: h.run, limit: 1, pollMs: 5,
      isDraining: () => draining, until: h.until, sleep: h.sleep, log: h.log });
    await settle();
    check("one job running at limit 1", h.started.join(",") === "20");
    draining = true;
    h.finish(20);
    await new Promise((r) => setTimeout(r, 40));
    check("after drain begins, the queued job is NOT claimed", h.started.length === 1, h.started.join(","));
    h.stop();
    await loop;
  }

  // -- D: a run() that throws does not stop the loop -----------------------
  {
    const h = harness([30, 31]);
    const loop = workerPump({
      claim: h.claim,
      run: async (row) => { if (row.id === 30) throw new Error("boom"); return h.run(row); },
      limit: 1, pollMs: 5, until: h.until, sleep: h.sleep, log: h.log });
    await settle();
    await new Promise((r) => setTimeout(r, 30));
    check("a throwing job is logged and the next one still runs",
      h.started.join(",") === "31" && h.logs.some((m) => /job 30 escaped/.test(m)), JSON.stringify(h.logs));
    h.finish(31); h.stop();
    await loop;
  }

  // -- E: a claim() failure is logged and retried, not fatal ---------------
  {
    let calls = 0;
    const h = harness([40]);
    const realClaim = h.claim;
    const loop = workerPump({
      claim: async () => { calls++; if (calls === 1) throw new Error("db hiccup"); return realClaim(); },
      run: h.run, limit: 1, pollMs: 5, until: h.until, sleep: h.sleep, log: h.log });
    await new Promise((r) => setTimeout(r, 40));
    check("claim failure is survived", h.started.join(",") === "40" && h.logs.some((m) => /claim failed: db hiccup/.test(m)));
    h.finish(40); h.stop();
    await loop;
  }

  // -- F: the memory probe returns a sane number on this host ---------------
  {
    const mb = availableMemoryMb();
    check("availableMemoryMb returns a positive number", Number.isFinite(mb) && mb > 0, `mb=${mb}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("HARNESS ERROR:", (e && e.stack) || e);
  process.exitCode = 1;
});
