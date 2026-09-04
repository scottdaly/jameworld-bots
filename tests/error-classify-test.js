// Run me: node tests/error-classify-test.js
// Pure function tests, no network or database.
const { isCapacityError, isAuthError, providerName, capacityRetryMessage,
        capacityFinalMessage, authFailureMessage } = require("../error-classify.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

// A bare .includes('401') matched inside "port 4010" -- confirmed by audit,
// not hypothetical. These are the cases that actually broke, plus the
// legitimate matches that must keep working alongside the fix.
const cases = [
  ["port 4010 refused connection", false, false],
  ["listening on 14010", false, false],
  ["timestamp 1429384756", false, false],
  ["model gpt-4030 not found", false, false],
  ["529 upstream error", true, false],
  ["overloaded_error: Overloaded", true, false],
  ["429 Too Many Requests", true, false],
  ["503 Service Unavailable", true, false],
  ["rate_limit_error: exceeded", true, false],
  ["401 authentication_error: invalid x-api-key", false, true],
  ["HTTP 403 Forbidden", false, true],
  ["invalid_grant: Token has been expired or revoked.", false, true],
  ["Please run `claude login` to authenticate", false, true],
];
for (const [msg, wantCap, wantAuth] of cases) {
  const e = new Error(msg);
  check(`"${msg}" -> capacity=${wantCap}`, isCapacityError(e) === wantCap,
    `got ${isCapacityError(e)}`);
  check(`"${msg}" -> auth=${wantAuth}`, isAuthError(e) === wantAuth,
    `got ${isAuthError(e)}`);
}

// The structured field takes precedence and must not need a matching
// substring in the message at all.
{
  const e = new Error("something unremarkable happened");
  e.apiErrorStatus = 529;
  check("apiErrorStatus=529 alone is enough to classify as capacity",
    isCapacityError(e) === true);
  check("apiErrorStatus=529 does not also read as auth", isAuthError(e) === false);
}
{
  const e = new Error("something unremarkable happened");
  e.apiErrorStatus = 401;
  check("apiErrorStatus=401 alone is enough to classify as auth",
    isAuthError(e) === true);
}

// Attribution: the joke's whole point is naming the provider that actually
// failed, not whichever one the bot happens to default to.
check("providerName maps anthropic correctly", providerName("anthropic") === "Anthropic");
check("providerName maps codex correctly", providerName("codex") === "OpenAI");
check("providerName maps both gemini variants to Google",
  providerName("gemini") === "Google" && providerName("gemini-api") === "Google");
check("capacity retry message names the given provider, not a hardcoded one",
  capacityRetryMessage("anthropic").includes("Anthropic") &&
  !capacityRetryMessage("anthropic").includes("Google"));
check("capacity final message names the given provider",
  capacityFinalMessage("gemini-api").includes("Google"));
check("auth failure message names the right env var per provider",
  authFailureMessage("anthropic").includes("CLAUDE_CODE_OAUTH_TOKEN") &&
  authFailureMessage("gemini-api").includes("GOOGLE_API_KEY") &&
  authFailureMessage("codex").includes("CODEX_API_KEY"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
