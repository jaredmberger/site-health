# OceanLiners.net Site Health

Private Cloudflare Worker for crawling `oceanliners.net`, checking internal and external links, classifying failures and redirects, and exporting audit results for CuratorOS.

## Cloudflare deployment

1. Create or connect a Worker to this GitHub repository.
2. Use the repository root as the project root.
3. Build command: `npm install`
4. Deploy command: `npx wrangler deploy`
5. Add the encrypted Worker secret `AUDIT_TOKEN`.
6. Attach the custom domain `site-health.oceanliners.net`.

The dashboard is served at `/`. The Worker source lives at `src/index.js`.
