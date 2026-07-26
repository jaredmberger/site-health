# OceanLiners.net Site Health

Private Cloudflare Worker for crawling `oceanliners.net`, checking internal and external links, classifying failures and redirects, and exporting audit results for CuratorOS.

## CuratorOS suite

- **CuratorOS:** `https://curator.oceanliners.net/`
- **Site Health:** `https://site-health.oceanliners.net/`
- **Curator Indexer:** `https://curator-indexer.oceanliners.net/`

Site Health is the auditing engine in the workflow:

`Scan → Explain → Locate → Recommend → Resolve`

Run an audit here, export the results, then use **Import Scan Results** in CuratorOS. Catalog files belong in **Load Catalog** and are not scan-result files.

## Exchange format

The stable findings contract is documented in [`docs/findings.schema.json`](docs/findings.schema.json).

- File: `findings.json`
- Schema: `https://oceanliners.net/curatoros/findings.schema.json`
- Schema version: `1.0`

## Cloudflare deployment

1. Create or connect a Worker to this GitHub repository.
2. Use the repository root as the project root.
3. Build command: `npm install`
4. Deploy command: `npx wrangler deploy`
5. Add the encrypted Worker secret `AUDIT_TOKEN`.
6. Attach the custom domain `site-health.oceanliners.net`.

The dashboard is served at `/`. The Worker source lives at `src/index.js`.
