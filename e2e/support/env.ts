// Where the local end-to-end stack lives (docker-compose.e2e.yml).

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const FAKES_URL = process.env.E2E_FAKES_URL ?? "http://localhost:4010";
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://localhost:8025";
export const CRON_SECRET = process.env.E2E_CRON_SECRET ?? "e2e-cron-secret";
export const META_APP_SECRET = process.env.E2E_META_APP_SECRET ?? "e2e-meta-app-secret";

/** `docker compose` invocation for the e2e project (used for `exec`). */
export const COMPOSE = [
  "compose",
  "-p",
  "wacrm-e2e",
  "--env-file",
  "e2e/.env.e2e",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.e2e.yml",
];

export const PASSWORD = "Passw0rd!e2e";
