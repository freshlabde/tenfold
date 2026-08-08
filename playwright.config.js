import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:7710",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tools/serve.js",
    url: "http://127.0.0.1:7710/tests/fixture.html",
    reuseExistingServer: true,
    stdout: "ignore",
  },
});
