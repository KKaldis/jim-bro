# Contributing to Jim-Bro

Thanks for helping out. Bug reports, fixes, translations and new features are all welcome.

## License and the Contributor License Agreement

Jim-Bro is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE).

Before your first pull request can be merged, you'll be asked to sign a **Contributor
License Agreement (CLA)**. A bot comments on the pull request with a link; it takes a minute,
and you only do it once. You keep the copyright to your work. The CLA gives the maintainer
the right to also offer your contribution under other licenses, including a commercial one,
which is how the project is funded.

## Getting set up

Follow [SETUP.md](SETUP.md). In short: install with `npm install`, copy `.env.example` to
`.env`, start the database with `docker compose up -d postgres`, run `npm run db:migrate`,
then `npm run server:dev` and `npm run web:dev`.

## Before you open a pull request

A pre-commit hook (installed by `npm install`) lints your staged files and runs the
typecheck on every commit. Before opening the pull request, also run the full set:

```sh
npm run typecheck
npm run lint
bun test
```

And, depending on what you changed:

- **Database schema** (`packages/db_postgres/src/schema.ts`): run `npm run db:generate` and
  commit the new file in `drizzle/`. Never edit an existing migration.
- **API shapes** (`packages/shared/src/schemas.ts` or an endpoint): run `npm run gen:api` so
  the web app's generated client matches.
- **User-facing text**: add the string to every locale in
  `apps/web/src/i18n/locales/<lang>/`, not just English. A rough translation is fine; say so in
  the pull request.
- **Pure logic** (calculations, parsing): put it in `packages/shared/src` with a test next to it.

## Pull requests

- Keep each pull request to one change, and explain what it fixes and how you tested it.
- Include screenshots for UI changes (light and dark theme if it touches colors).
- For anything large, open an issue first so we can agree on the approach.

## Reporting a security issue

Please don't open a public issue. Report it privately through GitHub's
"Report a vulnerability" button on the repository's Security tab.
