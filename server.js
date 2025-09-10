// server.js
import express from "express";
import puppeteer from "puppeteer";
import axios from "axios";
import { setTimeout as delay } from "timers/promises";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";

dotenv.config();

// -------- Config --------
const PORT = Number(process.env.PORT || 3002);
const APIVOID_KEY = process.env.APIVOID_KEY || ""; // if missing => fail with apivoid_api_key
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || ""; // if missing => fail with scraperapi
const PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

const MAX_URLS_PER_REQUEST = 50;
const CONCURRENCY = 2;
const PER_URL_TIMEOUT_MS = 60_000;
const TEXT_MAX_CHARS = 200_000;
const MIN_TEXT_FOR_OK = 300; // treat <300 chars as likely bot wall / failure

// -------- Utils --------
const log = (...a) => console.log(new Date().toISOString(), ...a);

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
function hostOnly(u) {
  try {
    return new URL(u).hostname;
  } catch {
    try {
      return new URL("http://" + u).hostname;
    } catch {
      return null;
    }
  }
}

function htmlToText(html) {
  if (!html) return "";
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

// Captcha/bot wall heuristic (conservative)
function looksLikeCaptcha(text, title = "") {
  const t = (text || "").toLowerCase();
  const tt = (title || "").toLowerCase();

  const strong = [
    "attention required",
    "access denied",
    "cloudflare",
    "unusual traffic",
    "verify you are human",
    "bot detected",
    "press and hold",
  ];
  if (strong.some((n) => tt.includes(n) || t.includes(n))) return true;

  const generic = ["captcha", "hcaptcha", "recaptcha", "are you a robot"];
  const mentionsGeneric = generic.some((n) => tt.includes(n) || t.includes(n));
  const tooShort = (text || "").length < MIN_TEXT_FOR_OK;

  return mentionsGeneric && tooShort;
}

// Concurrency limiter
function limiter(limit) {
  let active = 0;
  const q = [];
  const next = () => {
    active--;
    q.shift()?.();
  };
  return (fn) =>
    new Promise((res, rej) => {
      const run = async () => {
        active++;
        try {
          res(await fn());
        } catch (e) {
          rej(e);
        } finally {
          next();
        }
      };
      active < limit ? run() : q.push(run);
    });
}

// -------- External calls --------
async function apivoidCheck(host) {
  // Your spec: missing/wrong/expired/credit issues => failure_reason "apivoid_api_key"
  if (!APIVOID_KEY) {
    return { kind: "fail", reason: "apivoid_api_key", text: "APIVoid API key is missing." };
  }
  if (!host) {
    return { kind: "fail", reason: "wrong_format", text: "Host could not be derived from the URL." };
  }

  try {
    const { data, status } = await axios.post(
      "https://api.apivoid.com/v2/parked-domain",
      { host }, // host only (no scheme)
      {
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": APIVOID_KEY,
        },
        timeout: 12_000,
        validateStatus: () => true,
      }
    );

    // Handle known error shapes from v2
    if (status >= 400 || data?.error) {
      // Treat domain syntax errors as "wrong_format"
      const msg = data?.error || `APIVoid HTTP ${status}`;
      if (/domain name is not valid/i.test(msg)) {
        return {
          kind: "fail",
          reason: "wrong_format",
          text: `The input url domain is not valid for APIVoid (${msg}).`,
        };
      }
      // Insufficient credits / wrong key / expired key
      if (/insufficient|credit|api key|unauthorized|forbidden/i.test(msg)) {
        return {
          kind: "fail",
          reason: "apivoid_api_key",
          text: msg,
        };
      }
      // Other APIVoid-side errors
      return {
        kind: "fail",
        reason: "apivoid_api_key",
        text: msg,
      };
    }

    // Expected success shape (per your examples):
    // { "host":"x.com", "parked_domain":false, "a_records_found":true, "elapsed_ms":... }
    const aRecords = !!data?.a_records_found;
    const parked = !!data?.parked_domain;

    if (!aRecords) {
      return {
        kind: "fail",
        reason: "a_records_not_found",
        text: "The domain appeared to be offline on the Apivoid check.",
      };
    }
    if (parked) {
      return {
        kind: "fail",
        reason: "parked_domain",
        text: "The domain appeared to be a parked domain on the Apivoid check.",
      };
    }

    return { kind: "ok" };
  } catch (e) {
    // Network/timeouts → treat as key/plan issue per your failure bucket
    return {
      kind: "fail",
      reason: "apivoid_api_key",
      text: `APIVoid request failed: ${e?.message || e}`,
    };
  }
}

async function scraperApiFetch(url) {
  if (!SCRAPERAPI_KEY) {
    return {
      ok: false,
      reason: "scraperapi",
      text: "ScraperAPI key is missing.",
      httpStatus: null,
      title: "",
      content: "",
    };
  }
  try {
    const api = `https://api.scraperapi.com?api_key=${SCRAPERAPI_KEY}&render=true&url=${encodeURIComponent(
      url
    )}`;
    const resp = await axios.get(api, { timeout: 40_000, validateStatus: () => true });
    const html = typeof resp.data === "string" ? resp.data : "";
    const text = htmlToText(html).slice(0, TEXT_MAX_CHARS);
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = m ? htmlToText(m[1]).slice(0, 300) : "";

    if (resp.status >= 400) {
      return {
        ok: false,
        reason: "scraperapi",
        text: `ScraperAPI HTTP ${resp.status}`,
        httpStatus: resp.status,
        title,
        content: "",
      };
    }

    return { ok: true, httpStatus: resp.status, title, content: text };
  } catch (e) {
    return {
      ok: false,
      reason: "scraperapi",
      text: `ScraperAPI request failed: ${e?.message || e}`,
      httpStatus: null,
      title: "",
      content: "",
    };
  }
}

// -------- Puppeteer (singleton) --------
let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-zygote",
        "--single-process"
      ],
    });
  }
  return browserPromise;
}
async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  // give a little more breathing room on timeouts
  page.setDefaultNavigationTimeout(35_000);
  page.setDefaultTimeout(35_000);
  
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const t = req.resourceType();
    if (t === "image" || t === "font" || t === "media" || t === "stylesheet") req.abort();
    else req.continue();
  });
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

// robust extractor that tolerates mid-flight navigations
async function getTitleAndTextWithRetries(page, { attempts = 2, settleWaitMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      // Try reading title + body text
      const title = await page.title();
      const text = await page.evaluate(() => document.body?.innerText?.trim() || "");
      return { title, text };
    } catch (e) {
      const msg = String(e?.message || e);
      // Known transient errors when the frame reloads while evaluating
      const transient =
        /Execution context was destroyed|Cannot find context with specified id/i.test(msg);

      if (!transient) throw e; // real error — bubble up immediately
      lastErr = e;

      // Wait for things to settle, then give it another shot
      try {
        // If another nav is in progress, wait for the network to idle
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10_000 }).catch(() => {});
      } catch { /* ignore */ }
      await delay(settleWaitMs);
    }
  }
  throw lastErr || new Error("execution_context_retries_exhausted");
}

async function puppeteerFetch(url) {
  return withPage(async (page) => {
    // CHANGED: wait for both DOMContentLoaded and a brief network idle
    const resp = await page.goto(url, {
      waitUntil: ["domcontentloaded", "networkidle2"],
      timeout: 30_000,
    });

    const httpStatus = resp?.status() ?? null;

    // explicit offline/4xx/5xx signals on initial nav
    if (!httpStatus || httpStatus >= 400) {
      const title = await page.title().catch(() => "");
      return {
        ok: false,
        reason: "offline_on_puppeteer",
        text: `HTTP ${httpStatus ?? "no_response"}`,
        httpStatus,
        title,
        content: "",
      };
    }

    // CHANGED: robust text extraction with transient-navigation retries
    const { title, text } = await getTitleAndTextWithRetries(page, { attempts: 2, settleWaitMs: 600 });

    return { ok: true, httpStatus, title, content: text.slice(0, TEXT_MAX_CHARS) };
  });
}

// -------- Per-URL pipeline (exact contract) --------
async function processOne(inputUrl, reqId) {
  const start = Date.now();

  // 1) URL format check
  const url = normalizeUrl(inputUrl);
  if (!url) {
    return {
      status: "failure",
      url_input: inputUrl,
      failure_reason: "wrong_format",
      failure_text: `The input url \`${inputUrl}\` is not properly formatted.`,
      scraped_text: "",
      ms: Date.now() - start,
    };
  }

  // 2) APIVoid check (host only)
  const host = hostOnly(url);
  const apiRes = await apivoidCheck(host);
  if (apiRes.kind === "fail") {
    return {
      status: "failure",
      url_input: inputUrl,
      failure_reason: apiRes.reason,
      failure_text: apiRes.text,
      scraped_text: "",
      ms: Date.now() - start,
    };
  }

  // 3) Puppeteer fetch
  const hardCap = (p) =>
    Promise.race([
      p,
      (async () => {
        await delay(PER_URL_TIMEOUT_MS);
        throw new Error("timeout");
      })(),
    ]);

  let pptr = { ok: false, reason: "offline_on_puppeteer", text: "unknown", httpStatus: null, title: "", content: "" };
  try {
    pptr = await hardCap(puppeteerFetch(url));
  } catch (e) {
    pptr = { ok: false, reason: "offline_on_puppeteer", text: String(e?.message || e), httpStatus: null, title: "", content: "" };
  }

  if (!pptr.ok) {
    return {
      status: "failure",
      url_input: inputUrl,
      failure_reason: "offline_on_puppeteer",
      failure_text: pptr.text || "The webpage did not load.",
      scraped_text: "",
      ms: Date.now() - start,
    };
  }

  // 4) CAPTCHA / short content decision
  const isCaptchaOrShort =
    looksLikeCaptcha(pptr.content, pptr.title);

  if (!isCaptchaOrShort) {
    return {
      status: "success",
      url_input: inputUrl,
      failure_reason: "",
      failure_text: "",
      scraped_text: pptr.content,
      ms: Date.now() - start,
    };
  }

  // 5) ScraperAPI fallback
  log(`[${reqId}] CAPTCHA/short content → ScraperAPI retry: ${url}`);
  const viaProxy = await hardCap(scraperApiFetch(url));

  if (!viaProxy.ok) {
    return {
      status: "failure",
      url_input: inputUrl,
      failure_reason: viaProxy.reason || "scraperapi",
      failure_text: viaProxy.text || "ScraperAPI failed.",
      scraped_text: "",
      ms: Date.now() - start,
    };
  }

  const proxyBad =
    looksLikeCaptcha(viaProxy.content, viaProxy.title);

  if (proxyBad) {
    return {
      status: "failure",
      url_input: inputUrl,
      failure_reason: "scraperapi",
      failure_text: "ScraperAPI returned CAPTCHA/short content.",
      scraped_text: "",
      ms: Date.now() - start,
    };
  }

  return {
    status: "success",
    url_input: inputUrl,
    failure_reason: "",
    failure_text: "",
    scraped_text: viaProxy.content,
    ms: Date.now() - start,
  };
}

// -------- HTTP / Swagger --------
const app = express();
app.use(express.json({ limit: "1mb" }));

// Swagger @ /docs
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "Puppeteer Batch API", version: "1.0.0" },
  },
  apis: [], // we define inline below
});
swaggerSpec.paths = {
  "/batch-scrape": {
    post: {
      summary: "Scrape a batch of URLs (max 100)",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { urls: { type: "array", items: { type: "string" }, maxItems: MAX_URLS_PER_REQUEST } },
              required: ["urls"],
            },
          },
        },
      },
      responses: {
        200: {
          description: "Results for each URL",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  requestId: { type: "string" },
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["success", "failure"] },
                        url_input: { type: "string" },
                        failure_reason: { type: "string" },
                        failure_text: { type: "string" },
                        scraped_text: { type: "string" },
                        ms: { type: "number" }
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.post("/batch-scrape", async (req, res) => {
  const reqId = randomUUID().slice(0, 8);
  const list = Array.isArray(req.body?.urls) ? req.body.urls : null;
  if (!list) return res.status(400).json({ error: "Body must be { urls: string[] }" });

  const unique = [...new Set(list)];
  if (unique.length > MAX_URLS_PER_REQUEST) {
    return res.status(400).json({ error: `Too many URLs; max ${MAX_URLS_PER_REQUEST}.` });
  }

  const run = limiter(CONCURRENCY);
  const results = await Promise.all(unique.map((u) => run(() => processOne(u, reqId))));
  res.json({ requestId: reqId, results });
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.listen(PORT, async () => {
  console.log(`Batch Puppeteer API listening on ${PORT}`);
  try {
    const b = await getBrowser();
    log("Puppeteer:", await b.version());
  } catch (e) {
    log("Warning: failed to prelaunch browser:", e?.message || e);
  }
});

process.on("SIGTERM", async () => {
  try { const b = await browserPromise; if (b) await b.close(); }
  finally { process.exit(0); }
});
