import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The suite runs against its own server instance on 7711 with a throwaway
// data dir - never against the production server on 7710, whose
// ~/.tenfold-data would otherwise accumulate test vaults.
const TEST_PORT = 7711;
const TEST_DATA = join(tmpdir(), "tenfold-test-data");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${TEST_PORT}`,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Wipe the throwaway data dir first: vaults accumulate across runs and
    // would eventually trip the global MAX_VAULTS cap (a real 507 did occur).
    //
    // Then seed the relay's caller allowlist, because the gate in front of the
    // LOCAL upstreams below refuses a vault the operator never allowed. The
    // seed names ONE fixed sync id, the one tests/llm.spec.js registers when it
    // checks that a known vault may relay from outside; everything else in the
    // suite reaches the relay as a nameless local caller and needs no entry.
    // This is the real mechanism - an operator putting an id in the file - and
    // deliberately not a bypass env var, of which there is none.
    command: `rm -rf ${TEST_DATA} && mkdir -p ${TEST_DATA} && cp tests/llm_access.seed.json ${TEST_DATA}/llm_access.json && node tools/serve.js`,
    url: `http://127.0.0.1:${TEST_PORT}/tests/fixture.html`,
    reuseExistingServer: false,
    stdout: "ignore",
    env: {
      PORT: String(TEST_PORT),
      TENFOLD_DATA: TEST_DATA,
      // Lets the push tests point a subscription at a local http sink so the
      // VAPID header can be read back and verified. Off everywhere else - a
      // deployed server accepts https push endpoints only.
      TENFOLD_PUSH_ALLOW_INSECURE: "1",
      // The upstream allowlist of the model relay. tests/llm.spec.js starts a
      // mock OpenAI-compatible server on 7799 and tests/import.spec.js one on
      // 7797 - two ports because the two spec files run in parallel workers
      // and would otherwise fight over one socket. Without these entries the
      // relay refuses them with 403, which is the intended mechanism - an
      // operator names their model servers here, nobody bypasses the wall.
      TENFOLD_LLM_UPSTREAMS: "http://127.0.0.1:7799/v1,http://127.0.0.1:7797/v1",
    },
  },
});
