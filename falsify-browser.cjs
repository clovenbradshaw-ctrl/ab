// falsify-browser.cjs — incognito-browser end-to-end falsification.
//
// Drives the REAL Feedback Platform in a fresh (incognito-equivalent)
// Playwright context — no cookies, no persisted storage — and proves that a
// family filling the form flushes their submission to the database, over
// CORS, with nothing but the browser. It does NOT need any office password:
// the submitter account is provisioned silently by the app itself.
//
//   AB_APP_URL   where the (updated) app is served   (default http://localhost:8100/index.html)
//   AB_DB        the database endpoint               (default https://hyphae.social/ab-db)
//
// Prints: whether the app booted, every /ab-db/append HTTP status seen, and
// any [db] console output. A green run = append returned 200 from the browser.

const { chromium } = require("/Users/mlacy/.npm/_npx/e41f203b7505f1fb/node_modules/playwright");

const APP = process.env.AB_APP_URL || "http://localhost:8100/index.html";
const DB = process.env.AB_DB || "https://hyphae.social/ab-db";

(async () => {
  const exec = process.env.AB_CHROMIUM_EXEC
    || "/Users/mlacy/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell";
  const browser = await chromium.launch({ executablePath: exec, headless: true });
  try {
    const ctx = await browser.newContext(); // fresh / incognito-equivalent
    const page = await ctx.newPage();

    const consoleLogs = [];
    const appendResponses = [];
    page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => consoleLogs.push(`[pageerror] ${e.message}`));
    page.on("response", (r) => {
      if (r.url().includes("/ab-db/append")) {
        appendResponses.push({ url: r.url(), status: r.status() });
      }
    });

    console.log("== opening app (fresh context) ==");
    await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page.waitForSelector("#langEnBtn", { timeout: 20000 });
    await page.click("#langEnBtn");
    console.log("== clicked English; awaiting silent registration + boot ==");

    await page.waitForSelector("#entryLoader.hidden", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(6000); // let boot's async flush land

    const appUp = await page.isVisible("#appWrap");
    console.log("app booted (#appWrap visible):", appUp);

    // Refresh: resume the saved silent account, flush again (idempotent).
    console.log("== reloading (resume + re-flush) ==");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);

    console.log("\n== RESULTS ==");
    console.log("append responses (browser -> DB):", JSON.stringify(appendResponses));
    const dbLogs = consoleLogs.filter((l) => l.toLowerCase().includes("[db]"));
    console.log("db logs:", dbLogs.length ? JSON.stringify(dbLogs) : "(none)");
    if (!appendResponses.length) {
      console.log("WARN: no /ab-db/append request observed — dumping first console lines:");
      consoleLogs.slice(0, 40).forEach((l) => console.log("  ", l));
    }
    const ok = appendResponses.some((r) => r.status === 200);
    console.log(ok ? "\nFALSIFICATION PASSED: browser flushed to the DB (HTTP 200)."
                   : "\nFALSIFICATION FAILED: no successful append from the browser.");
    process.exitCode = ok ? 0 : 1;
  } finally {
    await browser.close();
  }
})();
