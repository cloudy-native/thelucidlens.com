# Contributing

Thanks for taking an interest. This is a small personal portfolio stack; light contributions are welcome.

## Scope

| In scope | Out of scope |
| --- | --- |
| Website (Astro), scripts, CDK stack | Original photographs (not in this repo) |
| Docs, bugs, small UX fixes | Deploying to the production AWS account |

Photographs live on a private drive / S3 and are **not** part of this project’s open-source grant. See [LICENSE](LICENSE) and the license notes in [README.md](README.md).

## Development

```bash
# Site
cd website
pnpm install
pnpm dev

# Stack (optional)
cd stack
npm install
npx cdk synth
```

See [README.md](README.md) for import/sync/deploy details.

## Pull requests

1. Open an issue first for larger changes (optional for tiny fixes).
2. Keep diffs focused.
3. Don’t commit secrets, AWS account IDs you don’t own, or image binaries.
4. Run `pnpm build` under `website/` (and stack tests if you touch CDK) before opening a PR.

## Code of conduct

Be kind. Harassment or spam will be closed without discussion.
