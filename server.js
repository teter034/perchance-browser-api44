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

    const promptBox = page.locator("textarea#input");
    await promptBox.waitFor({ state: "visible", timeout: 60000 });
    await promptBox.click();
    await promptBox.fill(prompt);

    const generateButton = page.getByRole("button", { name: /generate/i });
    await generateButton.waitFor({ state: "visible", timeout: 30000 });
    await generateButton.click();

    await page.waitForTimeout(15000);

    const title = await page.title();
    const url = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const imageCandidates = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img"))
        .map((img) => ({
          src: img.src,
          alt: img.alt || "",
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          className: img.className || ""
        }))
        .filter((img) => img.src && !img.src.startsWith("data:"))
        .slice(0, 30);
    });

    await browser.close();

    return res.json({
      ok: true,
      message: "Generate button clicked",
      prompt,
      title,
      url,
      bodyText: bodyText.slice(0, 2000),
      imageCandidates
    });
  } catch (error) {
    if (browser) {
      await browser.close().catch(() => {});
    }

    return res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
