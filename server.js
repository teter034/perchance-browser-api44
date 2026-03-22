import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Server is running" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.post("/generate", async (req, res) => {
  const { prompt } = req.body || {};

  if (!prompt) {
    return res.status(400).json({
      ok: false,
      error: "prompt is required"
    });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
      colorScheme: "light",
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false
    });

    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined
      });
      Object.defineProperty(navigator, "language", {
        get: () => "en-US"
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"]
      });
      Object.defineProperty(navigator, "platform", {
        get: () => "Win32"
      });
      Object.defineProperty(navigator, "hardwareConcurrency", {
        get: () => 8
      });
      Object.defineProperty(navigator, "deviceMemory", {
        get: () => 8
      });
      window.chrome = { runtime: {} };
    });

    await page.setExtraHTTPHeaders({
      "accept-language": "en-US,en;q=0.9"
    });

    await page.goto("https://perchance.org/ai-text-to-image-generator", {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });

    await page.waitForTimeout(12000);

    const titleBefore = await page.title();
    const urlBefore = page.url();

    const promptBox = page.locator("textarea.paragraph-input").first();
    await promptBox.waitFor({ state: "attached", timeout: 30000 });

    const promptDebug = await promptBox.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return {
        className: el.className,
        placeholder: el.getAttribute("placeholder"),
        display: s.display,
        visibility: s.visibility,
        opacity: s.opacity,
        width: r.width,
        height: r.height,
        disabled: el.disabled
      };
    });

    await promptBox.evaluate((el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, prompt);

    const generateButton = page.locator("#generateButtonEl").first();
    await generateButton.waitFor({ state: "attached", timeout: 30000 });

    const buttonDebug = await generateButton.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return {
        id: el.id,
        text: (el.innerText || el.textContent || "").trim(),
        display: s.display,
        visibility: s.visibility,
        opacity: s.opacity,
        width: r.width,
        height: r.height,
        disabled: el.disabled
      };
    });

    await generateButton.evaluate((el) => el.click());

    await page.waitForTimeout(20000);

    const titleAfter = await page.title();
    const urlAfter = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const imageCandidates = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img"))
        .map((img) => ({
          id: img.id || "",
          src: img.src || "",
          alt: img.alt || "",
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          className: img.className || "",
          title: img.title || ""
        }))
        .filter((img) => img.src)
        .slice(0, 50);
    });

    const resultImg = await page.evaluate(() => {
      const img = document.querySelector("#resultImgEl");
      if (!img) return null;

      return {
        id: img.id || "",
        src: img.getAttribute("src") || "",
        title: img.getAttribute("title") || "",
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      };
    });

    await browser.close();

    return res.json({
      ok: true,
      message: "Generate attempted",
      prompt,
      titleBefore,
      urlBefore,
      titleAfter,
      urlAfter,
      promptDebug,
      buttonDebug,
      resultImg,
      bodyText: bodyText.slice(0, 3000),
      imageCandidates
    });
  } catch (error) {
    const safeError =
      error instanceof Error ? error.stack || error.message : String(error);

    try {
      if (browser) await browser.close();
    } catch {}

    return res.status(500).json({
      ok: false,
      error: safeError
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
