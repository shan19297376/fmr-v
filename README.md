# Family Health Records

A private family medical-record PWA running on Cloudflare Workers.

- **D1** stores structured profiles, reports, tests, medicines, reminders and audit history.
- **R2** stores original documents encrypted by the Worker before upload.
- **Cloudflare Access** authenticates approved family accounts.
- **Gemini** transcribes uploaded reports in a background queue; it does not diagnose or recommend treatment.

The active application is served from `public/` by `src/index.ts`. Database changes are forward-only files under `migrations/`.

## Development

```bash
npm install
npm test
npm run dev
```

Deployment settings and required secrets are documented in `ARCHITECTURE.md` and `SETUP.md`.
