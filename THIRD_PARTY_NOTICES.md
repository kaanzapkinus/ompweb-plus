# Third-party notices

OMPWeb Plus is a community fork of [kahme247/ompweb](https://github.com/kahme247/ompweb), assembled from the tested upstream baseline `8888c15b23d7ff891da5d1670e158db851b10c27` and subsequent community changes. The root [MIT license](LICENSE), including its original copyright notice, remains intact. A fresh public release history does not change attribution or ownership of upstream code.

## Agent MCP

The optional vendored Agent MCP component comes from [37chengshan/agent-mcp](https://github.com/37chengshan/agent-mcp). It declares MIT licensing in `vendor/agent-mcp/pyproject.toml`. Its upstream copyright and complete license are retained in [vendor/agent-mcp/LICENSE](vendor/agent-mcp/LICENSE). Its own documentation, source attribution and notices remain with the component.

## Fonts and icons

The repository's MIT license does not replace the licenses of bundled fonts, their component icon sets, or installed dependencies. Nerd Fonts' licensing notice is retained in [app/fonts/SymbolsNerdFont-LICENSE.md](app/fonts/SymbolsNerdFont-LICENSE.md); its component source/version/license inventory is in [app/fonts/SymbolsNerdFont-README.md](app/fonts/SymbolsNerdFont-README.md). This includes MIT, Apache-2.0, CC-BY-4.0, OFL-1.1 and public-domain components. Refer to the listed upstream projects for their complete attribution requirements and trademark policies.

The Font Logos component's `v1.3.0` upstream LICENSE is the **Unlicense**, not an absence of licensing. Its verbatim text is retained in [app/fonts/FontLogos-LICENSE.txt](app/fonts/FontLogos-LICENSE.txt), obtained from [the exact component version](https://github.com/lukas-w/font-logos/blob/v1.3.0/LICENSE). Distribution of brand glyphs does not imply endorsement or trademark permission beyond applicable law.

Other font notices bundled in `app/fonts/` are retained. The application mark is generated from `public/omp-web-logo.svg`; it is not a substitute for third-party logo attribution.

## Dependencies

This source release includes `package-lock.json`, not a bundled `node_modules` directory. Dependency licenses remain with each installed package; the root license is not a blanket relicensing of those packages. Review their notices when distributing compiled or standalone builds.
