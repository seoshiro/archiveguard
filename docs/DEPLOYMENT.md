# Free static release

ArchiveGuard runs entirely in the browser. The public project site uses GitHub Pages; ordinary static files are the only hosted resources. The host never receives selected files, sidecar contents, or GPS coordinates.

## Reproduce the release

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium
ARCHIVEGUARD_BROWSER_CHANNEL=chromium npm run test:browser
```

PowerShell: set `$env:ARCHIVEGUARD_BROWSER_CHANNEL = 'chromium'` before the test command. The test configuration starts the local static preview automatically in CI. Installed Chrome can be used locally without a browser download.

Only `dist/` is uploaded by the release workflow. Every push to `main` must pass lint, strict types, core tests, production build, and browser checks before deployment. Pull requests run verification without a deployment. Official GitHub Actions are pinned to verified commit hashes. No account secrets, paid runners, paid service calls, or manually issued credentials are required by CI.

`version.json` records the exact source commit used to build the deployed release. Verify it against the successful workflow’s head SHA. The Vite base and demo/privacy URLs are relative, so the app works under the project path `/archiveguard/` and on another static host.

## Free-tier boundaries

[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) is available for public repositories on GitHub Free. [Standard GitHub-hosted Actions runners](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions) are free for public repositories. This workflow uses standard Ubuntu runners only.

[Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) include a 1 GB site limit and soft 100 GB/month bandwidth limit. This project’s static bundle is much smaller; photos never consume hosting bandwidth. Pages is appropriate for this free project utility and portfolio release. It does not support a commercial SaaS launch or commercial transactions under its usage rules. A later commercial offering needs a suitable host and separate authorization.

The host logs ordinary visitor requests/IP addresses for security. No telemetry is added by ArchiveGuard. The HTML includes a browser-enforced same-origin content security policy. GitHub Pages does not provide our local server’s custom HTTP headers; the local preview additionally enforces `frame-ancestors`, no-store, and read-only methods through headers.

## Rollback and backups

Keep the original photo archive backed up independently. Outputs are separate ZIP downloads; the app stores no archive server-side or between reloads. Keep a copy of a downloaded audit if you need its provenance later.

For a code rollback, revert the unwanted source commit on `main` and let the same verified workflow redeploy. Do not force-push unrelated history. The repository contains source and reproducible synthetic demo fixtures; raw local reports, publication helpers, credentials, caches, dependencies, build output, and user archives are excluded.
