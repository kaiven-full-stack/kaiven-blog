# Workspace Guide

## Project

- `kaiven-blog` is the Chinese-language “听雨” personal blog: an Astro 7 static site using Tailwind CSS v4 and Pagefind. Use Node.js `>=22.12.0` and npm.
- `src/pages/` defines routes, `src/layouts/BaseLayout.astro` is the shared shell, `src/components/` contains Astro-only UI, `src/utils/` contains post/date/reading-time logic, and Markdown posts live in `src/content/blog/`.
- The site has no framework islands. Keep browser behavior in the existing Astro/vanilla JavaScript pattern unless a framework integration is explicitly requested.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Commands

- Install dependencies with `npm install`.
- Build and validate content with `npm run build`; this runs `astro build` and then builds the Pagefind index in `dist/`.
- Preview the production output with `npm run preview`.
- There are no lint, test, format, or dedicated typecheck scripts. Use the production build as the required validation.
- Pagefind search data exists only after `npm run build`, so `/search` is not fully functional under the dev server.

## Content and architecture

- The `blog` collection schema is in `src/content.config.ts`. Post filenames are pinyin slugs and bodies are primarily Chinese Markdown.
- All listing pages and RSS must use `getPublishedPosts()` from `src/utils/posts.ts`; do not duplicate draft filtering or ordering.
- Adding a category requires updating the schema enum in `src/content.config.ts` plus `Category`, `CATEGORY_LABELS`, and `SERIES_ORDER` in `src/utils/posts.ts`.
- Imports are relative; no path aliases are configured.

## UI and styling

- Tailwind v4 is configured CSS-first in `src/styles/global.css`. Prefer the semantic paper/ink/cinnabar/line color tokens and existing font tokens over raw colors.
- Article typography uses the custom `.prose-ink` styles, not `@tailwindcss/typography`.
- Dark mode is class-based and coordinated by `BaseLayout.astro` through `localStorage('theme')` and the `theme-changed` event; keep Giscus theme synchronization intact.

## Deployment gotchas

- This is an assets-only Cloudflare deployment from `dist/`; do not run `astro add cloudflare` or introduce an SSR adapter without an explicit architecture change.
- `src/middleware.ts`, disabled Vite CORS in `astro.config.mjs`, the Giscus CSS endpoints, and `public/_headers` jointly support cross-origin Giscus themes. Do not remove or consolidate them without validating both development and deployed comments.
