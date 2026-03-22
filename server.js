import express from "express";

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

  return res.json({
    ok: true,
    message: "Generate endpoint works",
    prompt
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
