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

    const requestLog = [];
    const responseLog = [];
    const consoleLog = [];
    const pageErrors = [];

    page.on("request", (request) => {
      const url = request.url();
      if (
        url.includes("perchance") ||
        url.includes("image") ||
        url.includes("generate") ||
        url.includes("api")
      ) {
        requestLog.push({
          method: request.method(),
          url,
          resourceType: request.resourceType(),
          postData: request.postData()?.slice(0, 1000) || null
        });
      }
    });

    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("perchance") ||
        url.includes("image") ||
        url.includes("generate") ||
        url.includes("api")
      ) {
        responseLog.push({
          url,
          status: response.status(),
          contentType: response.headers()["content-type"] || ""
        });
      }
    });

    page.on("console", (msg) => {
      consoleLog.push({
        type: msg.type(),
        text: msg.text()
      });
    });

    page.on("pageerror", (err) => {
      pageErrors.push(String(err));
    });

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

    let targetFrame = null;
    const frameDebug = [];

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
      await browser.close();
      return res.status(500).json({
        ok: false,
        error: "Target frame with generate button not found",
        titleBefore,
        urlBefore,
        frameDebug
      });
    }

    const textareaDebug = await targetFrame.locator("textarea").evaluateAll((els) => {
      return els.map((el, i) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return {
          index: i,
          className: el.className || "",
          placeholder: el.getAttribute("placeholder") || "",
          width: r.width,
          height: r.height,
          area: r.width * r.height,
          display: s.display,
          visibility: s.visibility,
          opacity: s.opacity,
          disabled: el.disabled
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
        textareaDebug,
        frameDebug
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
      const oninputAttr = el.getAttribute("oninput") || "";
      let invokedHandler = false;
      let handlerError = null;

      try {
        const match = oninputAttr.match(/window\.(___inputElInputEvent\d+)/);
        if (match && typeof window[match[1]] === "function") {
          window[match[1]].bind(el)({ type: "input", target: el });
          invokedHandler = true;
        }
      } catch (e) {
        handlerError = String(e);
      }

      return {
        finalValue: el.value || "",
        chosenClass: el.className || "",
        chosenPlaceholder: el.getAttribute("placeholder") || "",
        oninputAttr,
        invokedHandler,
        handlerError
      };
    });

    const generateButton = targetFrame.locator("#generateButtonEl").first();

    const generateClickResult = await generateButton.evaluate((el) => {
      const onclickAttr = el.getAttribute("onclick") || "";
      let invokedHandler = false;
      let handlerError = null;

      try {
        el.click();
        const match = onclickAttr.match(/window\.(___generateButtonClickEvent\d+)/);
        if (match && typeof window[match[1]] === "function") {
          window[match[1]]({ type: "click", target: el });
          invokedHandler = true;
        }
      } catch (e) {
        handlerError = String(e);
      }

      return {
        onclickAttr,
        invokedHandler,
        handlerError
      };
    });

    await page.waitForTimeout(40000);

    const frameBodyText = await targetFrame.locator("body").innerText().catch(() => "");

    const imageCandidates = await targetFrame.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img")).map((img) => ({
        tag: "img",
        id: img.id || "",
        src: img.getAttribute("src") || "",
        currentSrc: img.currentSrc || "",
        className: img.className || "",
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0
      }));

      const canvases = Array.from(document.querySelectorAll("canvas")).map((el, i) => ({
        tag: "canvas",
        index: i,
        width: el.width || 0,
        height: el.height || 0,
        className: el.className || ""
      }));

      const bgCandidates = Array.from(document.querySelectorAll("*"))
        .map((el) => {
          const style = window.getComputedStyle(el);
          const bg = style.backgroundImage || "";
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: el.className || "",
            backgroundImage: bg,
            width: r.width,
            height: r.height
          };
        })
        .filter((x) => x.backgroundImage && x.backgroundImage !== "none")
        .slice(0, 20);

      return {
        imgs: imgs.slice(0, 50),
        canvases: canvases.slice(0, 20),
        bgCandidates
      };
    });

    await browser.close();

    return res.json({
      ok: true,
      message: "Generate attempted with network diagnostics",
      prompt,
      titleBefore,
      urlBefore,
      frameDebug,
      textareaDebug,
      chosenIndex,
      promptSetResult,
      generateClickResult,
      frameBodyText: frameBodyText.slice(0, 4000),
      requestLog: requestLog.slice(-50),
      responseLog: responseLog.slice(-50),
      consoleLog: consoleLog.slice(-50),
      pageErrors: pageErrors.slice(-20),
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
