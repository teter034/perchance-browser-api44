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
        const buttonCount = await frame.locator("#generateButtonEl").count();
        const textareaCount = await frame.locator("textarea").count();

        frameDebug.push({
          url: frame.url(),
          name: frame.name(),
          buttonCount,
          textareaCount
        });

        if (buttonCount > 0) {
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
      await browser.close();

      return res.status(500).json({
        ok: false,
        error: "Target frame with generate button not found",
        titleBefore,
        urlBefore,
        frameDebug,
        bodyText: bodyText.slice(0, 2000)
      });
    }

    const targetFrameUrl = targetFrame.url();

    const textareaDebug = await targetFrame.locator("textarea").evaluateAll((els) => {
      return els.map((el, i) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return {
          index: i,
          id: el.id || "",
          className: el.className || "",
          placeholder: el.getAttribute("placeholder") || "",
          display: s.display,
          visibility: s.visibility,
          opacity: s.opacity,
          width: r.width,
          height: r.height,
          area: r.width * r.height,
          disabled: el.disabled,
          valuePreview: (el.value || "").slice(0, 100)
        };
      });
    });

    const chosenIndex = await targetFrame.evaluate(() => {
      const textareas = Array.from(document.querySelectorAll("textarea"));

      const candidates = textareas
        .map((el, index) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return {
            index,
            width: r.width,
            height: r.height,
            area: r.width * r.height,
            display: s.display,
            visibility: s.visibility,
            opacity: s.opacity,
            disabled: el.disabled
          };
        })
        .filter((x) =>
          !x.disabled &&
          x.display !== "none" &&
          x.visibility !== "hidden" &&
          x.opacity !== "0" &&
          x.width > 50 &&
          x.height > 20
        )
        .sort((a, b) => b.area - a.area);

      return candidates.length ? candidates[0].index : -1;
    });

    if (chosenIndex < 0) {
      await browser.close();
      return res.status(500).json({
        ok: false,
        error: "No visible usable textarea found",
        titleBefore,
        urlBefore,
        targetFrameUrl,
        frameDebug,
        textareaDebug
      });
    }

    const promptBox = targetFrame.locator("textarea").nth(chosenIndex);
    await promptBox.scrollIntoViewIfNeeded().catch(() => {});
    await promptBox.click({ timeout: 15000, force: true });

    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await promptBox.fill("").catch(() => {});
    await promptBox.type(prompt, { delay: 35 });

    const promptSetResult = await promptBox.evaluate((el) => {
      return {
        ok: true,
        chosenId: el.id || "",
        chosenClass: el.className || "",
        chosenPlaceholder: el.getAttribute("placeholder") || "",
        finalValue: el.value || ""
      };
    });

    const generateButton = targetFrame.locator("#generateButtonEl").first();
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

    await generateButton.click({ force: true });

    await page.waitForTimeout(30000);

    const titleAfter = await page.title();
    const urlAfter = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const frameBodyText = await targetFrame.locator("body").innerText().catch(() => "");

    const resultImg = await targetFrame.evaluate(() => {
      const byId = document.querySelector("#resultImgEl");
      if (byId) {
        return {
          foundBy: "#resultImgEl",
          id: byId.id || "",
          src: byId.getAttribute("src") || "",
          currentSrc: byId.currentSrc || "",
          title: byId.getAttribute("title") || "",
          width: byId.naturalWidth || 0,
          height: byId.naturalHeight || 0
        };
      }

      const best = Array.from(document.querySelectorAll("img")).find((img) => {
        const src = img.getAttribute("src") || img.currentSrc || "";
        return src && !src.startsWith("data:");
      });

      if (!best) return null;

      return {
        foundBy: "first-non-data-img",
        id: best.id || "",
        src: best.getAttribute("src") || "",
        currentSrc: best.currentSrc || "",
        title: best.getAttribute("title") || "",
        width: best.naturalWidth || 0,
        height: best.naturalHeight || 0
      };
    });

    const imageCandidates = await targetFrame.evaluate(() => {
      return Array.from(document.querySelectorAll("img"))
        .map((img) => ({
          id: img.id || "",
          src: img.getAttribute("src") || "",
          currentSrc: img.currentSrc || "",
          alt: img.alt || "",
          title: img.title || "",
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          className: img.className || ""
        }))
        .filter((img) => img.src || img.currentSrc)
        .slice(0, 50);
    });

    await browser.close();

    return res.json({
      ok: true,
      message: "Generate attempted with typed input strategy",
      prompt,
      titleBefore,
      urlBefore,
      titleAfter,
      urlAfter,
      targetFrameUrl,
      frameDebug,
      textareaDebug,
      chosenIndex,
      promptSetResult,
      buttonDebug,
      resultImg,
      bodyText: bodyText.slice(0, 2000),
      frameBodyText: frameBodyText.slice(0, 3000),
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
