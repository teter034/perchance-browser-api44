import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Server is running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy"
  });
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
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.goto("https://perchance.org/ai-text-to-image-generator", {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });

    const title = await page.title();

    await browser.close();

    return res.json({
      ok: true,
      message: "Browser opened page successfully",
      prompt,
      title
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
