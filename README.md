# Puppeteer Batch Scraper — Deployment & API Guide

GitHub repo: **[https://github.com/RomanHrynchukG/puppeteer-batch](https://github.com/RomanHrynchukG/puppeteer-batch)**

---

## What this service does (quick)

* Accepts a **batch of URLs** (up to **50** per request). [**Important**]
* For each URL:
  1. Validates URL format
  2. Checks the domain with **APIVoid v2 /parked-domain**
  3. If safe/online → loads page with **Puppeteer** to extract **rendered text**
  4. If Puppeteer sees a bot wall/CAPTCHA/very short content → **retries via ScraperAPI**
* Processes requests **concurrently** (max 2 at a time). [**Important**]
* Returns a per-URL **status** with standardized failure reasons and messages.

---

## 1) Server requirements (Debian VPS)

* Tested on Debian 13 (Trixie)
* **Docker** & **git**
* Open inbound **TCP 3005** in your firewall / AWS Security Group (or map to another host port)

```bash
# Install docker & git if needed
sudo apt update
sudo apt install -y docker.io git

# Optional: start docker on boot
sudo systemctl enable --now docker
```

---

## 2) Get the code & configure

```bash
# Clone your repo
git clone https://github.com/RomanHrynchukG/puppeteer-batch.git
cd puppeteer-batch
```

### Environment variables

You’ll pass these at container runtime:

* `APIVOID_KEY` – your APIVoid API key (v2). Required for APIVoid checks.
* `SCRAPERAPI_KEY` – your ScraperAPI key. Required for CAPTCHA/short-content fallback.
* `PUPPETEER_EXECUTABLE_PATH` – set to `/usr/bin/chromium` (provided by the Docker image).
* `PORT` – internal port [Optional] (default **3002**).

> For local (non-Docker) dev, you can create a `.env` file. In Docker, use `-e` flags. [**Important**]

---

## 3) Build the Docker image

The provided **Dockerfile** (Debian slim + Chromium, non-root user) is already set up.

```bash
sudo docker build -t puppeteer-batch .
```

---

## 4) Run the container

### Standard run (listens on 3005 inside & outside)

```bash
sudo docker run -d --restart=always \
  -p 3005:3002 \
  -e APIVOID_KEY=your_apivoid_key \
  -e SCRAPERAPI_KEY=your_scraperapi_key \
  -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  --name puppeteer-batch \
  puppeteer-batch
```

### Map to a different external port (example: 8080 on host)

```bash
sudo docker run -d --restart=always \
  -p 8080:3002 \
  -e APIVOID_KEY=your_apivoid_key \
  -e SCRAPERAPI_KEY=your_scraperapi_key \
  -e PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  --name puppeteer-batch \
  puppeteer-batch
```

> Make sure your firewall/SG allows the host port you expose. (8080 for the above example)

---

## 5) Health check & docs

* Health:
  `curl http://<SERVER_IP>:3005/healthz` → `ok`

* Swagger UI (interactive docs):
  `http://<SERVER_IP>:3005/docs`

---

## 6) Calling the API

### Endpoint

`POST /batch-scrape`

### Body

```json
{
  "urls": [
    "https://example.com/",
    "https://httpstat.us/404",
    "https://remotehub.eu"
  ]
}
```

* Max 100 URLs per call (duplicates are de-duplicated)
* Processed with **concurrency = 2**

### Example cURL

```bash
curl -X POST "http://<SERVER_IP>:3005/batch-scrape" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/","https://httpstat.us/404","https://remotehub.eu"]}'
```

---

## 7) Response format (per-URL contract)

Each URL returns exactly one **result object**:

### Success

```json
{
  "status": "success",
  "url_input": "https://example.com/",
  "failure_reason": "",
  "failure_text": "",
  "scraped_text": "Example Domain ... (rendered text)"
}
```

### Failure categories

#### 1) wrong\_format

Input URL is not a proper `http(s)` URL, or APIVoid says the **domain name is not valid**.

```json
{
  "status": "failure",
  "url_input": "foobar",
  "failure_reason": "wrong_format",
  "failure_text": "The input url `foobar` is not properly formatted.",
  "scraped_text": ""
}
```

#### 2) a\_records\_not\_found

APIVoid says `a_records_found: false` (domain appears offline).

```json
{
  "status": "failure",
  "url_input": "http://dead-domain.example",
  "failure_reason": "a_records_not_found",
  "failure_text": "The domain appeared to be offline on the Apivoid check.",
  "scraped_text": ""
}
```

#### 3) parked\_domain

APIVoid says `parked_domain: true` (defunct/parked).

```json
{
  "status": "failure",
  "url_input": "https://remotehub.eu",
  "failure_reason": "parked_domain",
  "failure_text": "The domain appeared to be a parked domain on the Apivoid check.",
  "scraped_text": ""
}
```

#### 4) apivoid\_api\_key

APIVoid API key missing/invalid/expired/insufficient credits, or APIVoid request failed.

```json
{
  "status": "failure",
  "url_input": "https://x.com",
  "failure_reason": "apivoid_api_key",
  "failure_text": "Insufficient API credits", 
  "scraped_text": ""
}
```

*(Message varies: “APIVoid API key is missing.”, “APIVoid HTTP 401”, “APIVoid request failed: …”, etc.)*

#### 5) offline\_on\_puppeteer

The page didn’t load in Puppeteer (e.g., timeout, HTTP ≥ 400 at first hop).

```json
{
  "status": "failure",
  "url_input": "https://httpstat.us/404",
  "failure_reason": "offline_on_puppeteer",
  "failure_text": "HTTP 404",
  "scraped_text": ""
}
```

#### 6) scraperapi

Puppeteer saw a likely bot wall/CAPTCHA/very short content, we retried via ScraperAPI, but key invalid/out of credits, HTTP error, or still CAPTCHA/too short.

```json
{
  "status": "failure",
  "url_input": "https://some-site-that-blocks-bots.example",
  "failure_reason": "scraperapi",
  "failure_text": "ScraperAPI returned CAPTCHA/short content.",
  "scraped_text": ""
}
```

*(Other messages: “ScraperAPI key is missing.”, “ScraperAPI HTTP 402”, “ScraperAPI request failed: …”)*

### Batch wrapper

The top-level response includes a request id and array of results:

```json
{
  "requestId": "9a2d7c1f",
  "results": [
    { "... per-URL object as above ..." }
  ]
}
```

---

## 8) How the checks flow (per URL)

1. **URL format**

   * Not a valid `http/https` URL → `wrong_format` (fail)

2. **APIVoid v2 (`/parked-domain`)** with domain only

   * `a_records_found: false` → `a_records_not_found` (fail)
   * `parked_domain: true` → `parked_domain` (fail)
   * API key/credit/HTTP error → `apivoid_api_key` (fail)
   * Otherwise → continue

3. **Puppeteer** (rendered text)

   * If network/HTTP error at first hop → `offline_on_puppeteer` (fail)
   * If content **looks like bot wall/CAPTCHA** or **< 300 chars** → fallback to ScraperAPI

4. **ScraperAPI fallback**

   * If key/credit/HTTP error or still CAPTCHA/short → `scraperapi` (fail)
   * Else → `success` with rendered text

---

## 9) Production notes & troubleshooting

* **Chromium inside Docker**: The image installs `chromium` and all required libs. The app launches it via `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.
* **Sandbox error (“No usable sandbox!”)**:
  If you see this, add these flags to `puppeteer.launch`:

  ```
  --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --no-zygote --single-process
  ```

  (Some container runtimes/hosts require sandbox disabled.)
* **Security**: If public-facing, add auth and rate limiting in front of this service.
* **Performance**: Concurrency is 2 by default. Adjust `CONCURRENCY`, `PER_URL_TIMEOUT_MS`, and `MIN_TEXT_FOR_OK` in `server.js` as needed.

---

## 10) Local (non-Docker) dev (optional)

```bash
# Install Chromium
sudo apt update && sudo apt install -y chromium

# In project folder
echo "PORT=3002" > .env
echo "APIVOID_KEY=your_apivoid_key" >> .env
echo "SCRAPERAPI_KEY=your_scraperapi_key" >> .env
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium" >> .env

npm install
node server.js

# Test
curl http://localhost:3002/healthz
open http://localhost:3002/docs
```

---

## 11) File list (expected)

```
puppeteer-batch/
├─ Dockerfile
├─ package.json
├─ server.js
└─ (optional) .env   # for local dev only, not used in Docker
```
