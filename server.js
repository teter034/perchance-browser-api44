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

    const title = await page.title();
    const url = page.url();

    const visibleTextareas = await page.locator("textarea").evaluateAll((els) => {
      return els.map((el, i) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          index: i,
          id: el.id,
          placeholder: el.getAttribute("placeholder"),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: r.width,
          height: r.height,
          disabled: el.disabled
        };
      });
    });

    const promptSetResult = await page.evaluate((promptText) => {
      const textareas = Array.from(document.querySelectorAll("textarea"));

      const candidate = textareas.find((el) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return (
          r.width > 100 &&
          r.height > 20 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          !el.disabled
        );
      });

      if (!candidate) {
        return { ok: false, reason: "No suitable textarea found" };
      }

      candidate.focus();
      candidate.value = promptText;
      candidate.dispatchEvent(new Event("input", { bubbles: true }));
      candidate.dispatchEvent(new Event("change", { bubbles: true }));

      return {
        ok: true,
        id: candidate.id,
        placeholder: candidate.getAttribute("placeholder")
      };
    }, prompt);

    if (!promptSetResult.ok) {
      throw new Error(
        `Prompt set failed: ${JSON.stringify({
          promptSetResult,
          visibleTextareas
        })}`
      );
    }

    const visibleButtonsDebug = await page.locator("button").evaluateAll((els) => {
      return els.map((el, i) => {
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          index: i,
          text: (el.innerText || el.textContent || "").trim(),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: r.width,
          height: r.height,
          disabled: el.disabled
        };
      });
    });

    const generateClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));

      const btn = buttons.find((el) => {
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return (
          txt.includes("generate") &&
          r.width > 20 &&
          r.height > 20 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          !el.disabled
        );
      });

      if (!btn) {
        return { ok: false, reason: "Generate button not found" };
      }

      btn.click();

      return {
        ok: true,
        text: (btn.innerText || btn.textContent || "").trim()
      };
    });

    if (!generateClicked.ok) {
      throw new Error(
        `Generate click failed: ${JSON.stringify({
          generateClicked,
          visibleButtonsDebug
        })}`
      );
    }

    await page.waitForTimeout(15000);

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
        .slice(0, 50);
    });

    await browser.close();

    return res.json({
      ok: true,
      message: "Generate button clicked",
      prompt,
      title,
      url,
      promptSetResult,
      generateClicked,
      visibleTextareas,
      visibleButtonsDebug,
      bodyText: bodyText.slice(0, 2000),
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
