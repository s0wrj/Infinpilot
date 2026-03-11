# InfinPilot

InfinPilot is a Chrome and Firefox browser extension that combines chat, browser automation, deep research, collective research, project management, and a multi-format editor in one side panel.

## Highlights

- Multi-mode workflow: normal chat, browser automation, deep research, and collective research
- Project workspace: capture pages, extract structured content, save templates, runs, and research outputs
- Built-in editors: Markdown, DOCX, Sheet, and SVG
- Research tooling: sub-agent execution, collective blackboard/chatroom collaboration, report packaging
- MCP integration: dynamic tools, resources, prompts, and project/context import
- Browser-native tools: tabs, bookmarks, history, windows, downloads, screenshots, scraping
- Cross-browser builds for Chrome and Firefox

## Repository Layout

- [html](html)
- [css](css)
- [js](js)
- [scripts](scripts)
- [manifest.base.json](manifest.base.json)
- [manifest.chrome.json](manifest.chrome.json)
- [manifest.firefox.json](manifest.firefox.json)

## Development

Install dependencies:

```bash
pnpm install
```

Build unpacked extension bundles:

```bash
pnpm run build:firefox
pnpm run build:chrome
```

Build release bundles:

```bash
pnpm run build:firefox:release
pnpm run build:chrome:release
```

Build readable release bundles without minification or obfuscation:

```bash
pnpm run build:firefox:release:plain
pnpm run build:chrome:release:plain
```

Output folders:

- `dist/firefox`
- `dist/chrome`

## Loading the Extension

Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this repository folder

Firefox:

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on`
3. Select [manifest.firefox.json](manifest.firefox.json)
