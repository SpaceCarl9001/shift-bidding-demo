// Local server: serves public/ and runs the api/*.js handlers the same way Vercel does.
// Secrets are read from .env.local (or .env). See .env.example.
const fs = require("fs");
const path = require("path");
const express = require("express");

for (const file of [".env.local", ".env"]) {
  if (fs.existsSync(path.join(__dirname, file))) process.loadEnvFile(path.join(__dirname, file));
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Each api/<name>.js file becomes /api/<name>, matching Vercel's routing
const apiDir = path.join(__dirname, "api");
for (const file of fs.readdirSync(apiDir).filter(f => f.endsWith(".js"))) {
  const handler = require(path.join(apiDir, file));
  app.all(`/api/${path.basename(file, ".js")}`, (req, res) => handler(req, res));
}
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Shift Bidding running at http://localhost:${port}`));
