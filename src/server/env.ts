/**
 * Loads `.env` from the project root into `process.env`.
 *
 * MUST be the first import in `src/server/index.ts`. Several downstream
 * modules capture environment variables at module-evaluation time (notably
 * `Analytics.ts`, which reads `ANALYTICS_WEBHOOK_URL` / `ANALYTICS_SECRET`
 * into top-level constants). Because ES module imports execute depth-first,
 * importing this file BEFORE any other server module guarantees `.env` is
 * applied before those captures happen.
 *
 * Why not use `dotenv`: Node 21.7+ has `process.loadEnvFile()` built in.
 * No dependency, no build step, identical behaviour for our needs.
 *
 * Why not the `node --env-file=.env` CLI flag: `npm run dev:server` uses
 * `tsx watch`, which forwards user args to the watched script rather than
 * to the Node runtime — so a `--env-file` flag wouldn't reach Node. Doing
 * it in-process keeps the dev and prod start commands aligned.
 *
 * Production note: on render.com (and any deploy target where env vars are
 * set directly by the platform), there's no `.env` file present. The
 * try/catch swallows that — platform-set vars are already in `process.env`,
 * so nothing further is needed.
 */

type LoadEnvFile = (path?: string) => void;

const loader: LoadEnvFile | undefined =
  (process as unknown as { loadEnvFile?: LoadEnvFile }).loadEnvFile;

if (typeof loader === 'function') {
  try {
    loader();
    console.log('[env] Loaded .env from project root');
  } catch {
    // No .env file present (production / CI) — env vars come from the
    // platform. Silent: this is the normal happy path on render.com.
  }
} else {
  console.warn('[env] process.loadEnvFile not available — requires Node 21.7+. ' +
    'Set env vars directly or upgrade Node.');
}
