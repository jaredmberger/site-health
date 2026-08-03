# Site Health Repair Center

The Repair Center turns verified Site Health findings into reviewable GitHub pull requests for `jaredmberger/Ocean-Liner-Curator`.

## Safety model

- The browser never receives a GitHub credential.
- The existing `AUDIT_TOKEN` is still required before repair endpoints can be called.
- Repairs are restricted to pages under `https://oceanliners.net/` and are mapped to HTML files in `jaredmberger/Ocean-Liner-Curator`.
- Only two operations are accepted: `replace` and `remove_link`.
- `replace` changes only the matching literal `href` value.
- `remove_link` removes only the matching `<a>` wrapper and preserves the visible anchor text and nested markup.
- Every requested old URL must be confirmed in a literal `href` attribute in the repository copy before a commit is created.
- Site Health creates a generated repair branch, one Git commit containing all selected file changes, and a **draft** pull request.
- Site Health never writes a repair directly to `main`.

The scanner also masks `<script>` and `<style>` blocks before extracting anchors so JavaScript strings that merely resemble HTML links are not reported as literal page links.

## Required Worker secrets

Site Health already requires:

```text
AUDIT_TOKEN
```

Repair Center additionally requires:

```text
GITHUB_TOKEN
```

Use a fine-grained GitHub token restricted to `jaredmberger/Ocean-Liner-Curator` with these repository permissions:

- Contents: Read and write
- Pull requests: Read and write
- Metadata: Read

Add it to the deployed `site-health` Cloudflare Worker as an encrypted secret. Do not place the token in GitHub, `wrangler.toml`, browser storage, or frontend code.

## Workflow

1. Run a full Site Health audit.
2. Broken findings show a Repair control.
3. Select findings to repair.
4. Choose **Replace URL** when a suggested replacement is appropriate, or **Remove hyperlink** when the dead destination should be de-linked while preserving visible text.
5. Choose **Create repair PR**.
6. Site Health validates every selected repair against the current `main` branch of the public-site repository.
7. If validation succeeds, Site Health creates a generated branch, a single repair commit, and a draft pull request.
8. Review the PR and merge it through the normal GitHub workflow.
9. Re-run Site Health to verify the findings are resolved.

If a requested URL cannot be found as a literal repository `href`, no PR is created and the finding is returned for manual review.
