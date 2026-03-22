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

    await page.waitForTimeout(20000);

    const titleBefore = await page.title();
    const urlBefore = page.url();

    const frameDebug = [];
    let targetFrame = null;

    for (const frame of page.frames()) {
      try {
        const textareaCount = await frame.locator("textarea.paragraph-input").count();
        const buttonCount = await frame.locator("#generateButtonEl").count();
        const genericTextareaCount = await frame.locator("textarea").count();

        frameDebug.push({
          url: frame.url(),
          name: frame.name(),
          textareaCount,
          buttonCount,
          genericTextareaCount
        });

        if ((textareaCount > 0 || genericTextareaCount > 0) && buttonCount > 0) {
          targetFrame = frame;
        }
      } catch (e) {
        frameDebug.push({
          url: frame.url(),
          name: frame.name(),
          error: String(e)
        });
      }
    }

    if (!targetFrame) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const htmlSnippet = (await page.content()).slice(0, 3000);

      await browser.close();

      return res.status(500).json({
        ok: false,
        error: "Target frame not found",
        titleBefore,
        urlBefore,
        frameDebug,
        bodyText: bodyText.slice(0, 2000),
        htmlSnippet
      });
    }

    const promptBox = targetFrame.locator("textarea.paragraph-input").first();
    const generateButton = targetFrame.locator("#generateButtonEl").first();

    const promptExists = await promptBox.count();
    const buttonExists = await generateButton.count();

    if (!promptExists || !buttonExists) {
      const bodyText = await page.locator("body").innerText().catch(() => "");

      await browser.close();

      return res.status(500).json({
        ok: false,
        error: "Prompt textarea or generate button missing in selected frame",
        titleBefore,
        urlBefore,
        frameDebug,
        promptExists,
        buttonExists,
        bodyText: bodyText.slice(0, 2000)
      });
    }

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

    await promptBox.evaluate((el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, prompt);

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
      targetFrameUrl: targetFrame.url(),
      frameDebug,
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
