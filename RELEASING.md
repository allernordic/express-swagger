# Releasing to npm

`.github/workflows/release.yaml` publishes on a `v*` tag push using OIDC trusted publishing (no `NPM_TOKEN`). Tags ending in literal `-rc` go to the `rc` dist-tag; everything else goes to `latest`.

> Note: the RC check is a literal `endsWith('-rc')`. SemVer-style `v0.1.0-rc.1` would publish to `latest` — use plain `v0.1.0-rc`.

`package.json` declares `"prepublishOnly": "npm run build"`, so `npm publish` automatically rolls up `lib/index.cjs`, regenerates `types/index.d.ts`, and refreshes the README TOC before pushing the tarball.

## Cutting a release

Bump `package.json#version` to match the intended tag, commit, then:

```bash
git tag v0.0.2 && git push --tags
```

For an RC, bump `version` to `0.0.2-rc` and tag with the matching `-rc` suffix:

```bash
git tag v0.0.2-rc && git push --tags
```

The workflow picks up the tag and publishes.
