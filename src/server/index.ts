import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Serve the built Phaser client from dist/
app.use(express.static(path.join(__dirname, '../../dist')));

// SPA fallback — serve index.html for any non-file route
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Roombov server running on port ${PORT}`);
});
