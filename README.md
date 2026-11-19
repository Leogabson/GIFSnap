# GIFSnap

GIFSnap is a public web application and Telegram bot service that turns Twitter/X GIFs into:

1. **WhatsApp-compliant animated stickers**: `.webp`, 512x512, max 500 KB, max 10 s duration.
2. **WhatsApp-ready GIFs**: short, looped, muted H.264 MP4 videos.

Users paste a tweet URL directly into the web application or interact with the Telegram bot—no signup required in v1.

---

## Prerequisites

- **Node.js**: `>=22` (Node.js 22 LTS recommended, see `.nvmrc`)
- **Package Manager**: `pnpm` (`>=12`) or `npm` (`>=10`) — dual package manager support is configured out of the box with both `pnpm-lock.yaml` and `package-lock.json`.

---

## Setup & Installation

1. **Clone the repository**:

   ```bash
   git clone <repo-url>
   cd GIFSnap
   ```

2. **Ensure Node.js 22 is active**:

   ```bash
   nvm use
   ```

3. **Install dependencies**:
   - **Using pnpm (recommended)**:
     ```bash
     pnpm install --frozen-lockfile
     ```
   - **Using npm**:
     ```bash
     npm ci
     ```

4. **Prepare Environment Variables**:
   Copy `.env.example` to `.env.local` (all variables are optional during Task 1 scaffolding):

   ```bash
   cp .env.example .env.local
   ```

5. **Start Development Server**:
   - With pnpm:
     ```bash
     pnpm dev
     ```
   - With npm:
     ```bash
     npm run dev
     ```
   Open [http://localhost:3001](http://localhost:3001) to view the application.

---

## Available Scripts

| Script         | pnpm Command        | npm Command            | Description                                    |
| -------------- | ------------------- | ---------------------- | ---------------------------------------------- |
| `dev`          | `pnpm dev`          | `npm run dev`          | Starts Next.js development server on port 3001 |
| `build`        | `pnpm build`        | `npm run build`        | Compiles the optimized production build        |
| `start`        | `pnpm start`        | `npm run start`        | Starts the production server on port 3001      |
| `lint`         | `pnpm lint`         | `npm run lint`         | Runs ESLint analysis                           |
| `typecheck`    | `pnpm typecheck`    | `npm run typecheck`    | Runs TypeScript compiler checks                |
| `test`         | `pnpm test`         | `npm run test`         | Runs unit and route tests with Vitest          |
| `format`       | `pnpm format`       | `npm run format`       | Formats all files using Prettier               |
| `format:check` | `pnpm format:check` | `npm run format:check` | Verifies code formatting                       |

---

## Project Structure

```
.
├── .github/
│   └── workflows/
│       └── ci.yml          # GitHub Actions CI pipeline
├── public/                 # Static assets
├── scripts/                # Local CLI and maintenance scripts (empty in v1)
├── src/
│   ├── app/                # Next.js App Router (pages and API routes)
│   │   ├── api/
│   │   │   └── healthz/    # Health check endpoint (Node.js runtime)
│   │   ├── globals.css     # Global Tailwind CSS styles
│   │   ├── layout.tsx      # Root HTML layout and fonts
│   │   └── page.tsx        # Responsive home page placeholder
│   ├── components/         # Reusable React UI components
│   └── lib/                # Shared logic and utilities
│       └── config.ts       # Typed Zod environment schema & config
├── tests/                  # Test suites (Vitest)
│   ├── config.test.ts      # Env validation tests
│   └── healthz.test.ts     # Health endpoint tests
├── .env.example            # Documented environment variables template
├── .nvmrc                  # Node version (22)
├── .prettierignore         # Prettier ignore patterns (includes lockfiles)
├── .prettierrc             # Prettier formatting config
├── eslint.config.mjs       # ESLint 9 flat configuration
├── next.config.ts          # Next.js configuration
├── package.json            # Project manifest and scripts
├── package-lock.json       # npm lockfile (dual support)
├── pnpm-lock.yaml          # pnpm lockfile (dual support)
├── tsconfig.json           # TypeScript configuration (strict mode)
├── vercel.json             # Vercel deployment configuration
└── vitest.config.mts       # Vitest test runner configuration
```

---

## Environment Variables

All variables are optional in the scaffolding phase so the application can start without configuration. They will be utilized in subsequent feature releases:

| Variable                   | Required | Description                                                            |
| -------------------------- | -------- | ---------------------------------------------------------------------- |
| `BLOB_READ_WRITE_TOKEN`    | Optional | Vercel Blob storage token for storing generated stickers and MP4 clips |
| `UPSTASH_REDIS_REST_URL`   | Optional | Upstash Redis REST endpoint for IP and rate-limiting enforcement       |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Upstash Redis REST access token                                        |
| `TURNSTILE_SITE_KEY`       | Optional | Cloudflare Turnstile public site key for bot verification              |
| `TURNSTILE_SECRET_KEY`     | Optional | Cloudflare Turnstile secret key for server-side token validation       |
| `TELEGRAM_BOT_TOKEN`       | Optional | Telegram Bot API token for bot interactions                            |
| `TELEGRAM_WEBHOOK_SECRET`  | Optional | Secret token to authenticate incoming Telegram webhook calls           |
| `CRON_SECRET`              | Optional | Secret key protecting scheduled cron maintenance endpoints             |
| `VERCEL_GIT_COMMIT_SHA`    | Optional | Provided automatically by Vercel; exposed via `/api/healthz`           |

---

## Deploy to Vercel

1. **Push to GitHub**:
   Ensure all changes are committed to the `main` branch of your GitHub repository.

2. **Import Project to Vercel**:
   - Navigate to [Vercel Dashboard](https://vercel.com/new).
   - Click **Import** next to your GitHub repository.
   - **Framework Preset**: Verify it is set to `Next.js`.
   - **Node.js Version**: In Project Settings -> General, ensure Node.js is set to `22.x`.
   - **Build & Development Settings**: Keep defaults (Vercel automatically detects `pnpm-lock.yaml` or `package-lock.json`).

3. **Verify Deployment Health**:
   Once the build completes and the deployment is live, verify the health route:
   ```bash
   curl -i https://<your-project>.vercel.app/api/healthz
   ```
   Expected response:
   - Status: `200 OK`
   - Header: `Cache-Control: no-store`
   - JSON: `{"status":"ok","time":"<ISO timestamp>","commit":"<commit-sha>"}`
