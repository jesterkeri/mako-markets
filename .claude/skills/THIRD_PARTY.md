# Third-party skills

Vendored copies of open-source Claude Code skills used for motion design work.

| Skill folder(s) | Source | Commit | License |
|---|---|---|---|
| `business-motion-film/` | https://github.com/echris6/motion-video-kit | 255562b | MIT (`business-motion-film/LICENSE`) |
| `threejs-*/` (10 skills) | https://github.com/cloudai-x/threejs-skills | b1c6230 | MIT (stated in the upstream README) |

These plugins are not vendored here. They are enabled in `.claude/settings.json` and install from GitHub:

| Plugin | Source | License |
|---|---|---|
| `hyperframes@hyperframes` (21 skills) | https://github.com/heygen-com/hyperframes | Apache-2.0 |
| `product-film@product-film-skill` | https://github.com/Rieranthony/product-film-skill | MIT |

To update a vendored skill, re-copy its folder from the upstream repo and bump the commit above.
