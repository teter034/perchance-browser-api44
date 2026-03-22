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
          disabled: el.disabled,
          valuePreview: (el.value || "").slice(0, 80)
        };
      });
    });

    const promptSetResult = await targetFrame.evaluate((promptText) => {
      const textareas = Array.from(document.querySelectorAll("textarea"));

      if (!textareas.length) {
        return { ok: false, reason: "No textarea elements found" };
      }

      let chosen = null;

      for (const el of textareas) {
        if (el.disabled) continue;

        const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
        const cls = (el.className || "").toLowerCase();
        const id = (el.id || "").toLowerCase();

        if (
          placeholder.includes("woman") ||
          placeholder.includes("tai chi") ||
          cls.includes("paragraph-input") ||
          id === "input"
        ) {
          chosen = el;
          break;
        }
      }

      if (!chosen) {
        chosen = textareas.find((el) => !el.disabled) || null;
      }

      if (!chosen) {
        return { ok: false, reason: "No enabled textarea found" };
      }

      chosen.focus();
      chosen.value = promptText;
      chosen.dispatchEvent(new Event("input", { bubbles: true }));
      chosen.dispatchEvent(new Event("change", { bubbles: true }));
      chosen.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

      return {
        ok: true,
        chosenId: chosen.id || "",
        chosenClass: chosen.className || "",
        chosenPlaceholder: chosen.getAttribute("placeholder") || "",
        finalValue: chosen.value
      };
    }, prompt);

    if (!promptSetResult.ok) {
      await browser.close();
      return res.status(500).json({
        ok: false,
        error: "Prompt set failed",
        titleBefore,
        urlBefore,
        targetFrameUrl,
        frameDebug,
        textareaDebug,
        promptSetResult
      });
    }

    const buttonDebug = await targetFrame.locator("#generateButtonEl").evaluate((el) => {
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

    await targetFrame.locator("#generateButtonEl").evaluate((el) => el.click());

    await page.waitForTimeout(25000);

    const titleAfter = await page.title();
    const urlAfter = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const frameBodyText = await targetFrame.locator("body").innerText().catch(() => "");

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

    await browser.close();

    return res.json({
      ok: true,
      message: "Generate attempted with generic textarea strategy",
      prompt,
      titleBefore,
      urlBefore,
      titleAfter,
      urlAfter,
      targetFrameUrl,
      frameDebug,
      textareaDebug,
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
