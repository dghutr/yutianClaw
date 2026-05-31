# Bundled Skills

Project-local skills live in this directory. `scripts/package-resources.js` copies every
subdirectory that contains `SKILL.md` into the bundled Gateway runtime at:

`resources/targets/<platform>-<arch>/gateway/node_modules/openclaw/skills/`

Bundled video skills:

- `pdf`
- `image2`
- `hyperframes-video-generator`
- `hyperframes`
- `hyperframes-cli`
- `hyperframes-registry`
- `website-to-hyperframes`
- `gsap`

After changing these skills, run `npm run package:resources:win:x64` before starting the app.
