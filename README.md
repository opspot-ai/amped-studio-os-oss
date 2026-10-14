# Amped Studio OS

Amped Studio OS is an experimental, as-is source snapshot for a local company-planning runtime. It includes the control, admin, and studio apps; CLI, MCP, and worker entry points; domain, policy, storage, adapter, and contract packages; and synthetic examples. Bugs, incomplete features, and outdated dependencies may be present. No production, security, or runtime acceptance is implied.

## Prerequisites and local setup

Use Node.js 24 or newer and pnpm 11.15.1 or newer. The included `.env.example` uses local defaults and blank provider credentials. Copy it to `.env` and add only operator-owned configuration when needed.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run setup
pnpm run doctor
pnpm run dev
```

`pnpm run setup -- --import-example` explicitly imports the synthetic pack; ordinary setup is unseeded. `pnpm run dev` starts the control app and worker. Other app and entry-point commands are listed in the root `package.json` scripts. The available test and build scripts are source commands only and are not verified by this snapshot.

## Scope and limitations

This snapshot contains existing source with sanitation-only edits. Provider integrations require operator configuration. Configure deployment, authentication, data handling, legal terms, support, and security controls for your environment before serving users.
