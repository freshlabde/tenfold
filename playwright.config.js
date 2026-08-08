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
    command: "node tools/serve.js",
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
    },
  },
});
