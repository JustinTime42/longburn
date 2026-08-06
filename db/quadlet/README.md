# Test Postgres quadlet (longburn-667)

`longburn-postgres.container` defines a standing podman quadlet user service:
Postgres 17 on `127.0.0.1:5433`, bootstrap superuser `longburn_test` /
`longburn_test` (deliberately non-secret — the instance is test-only and
localhost-bound). It exists so the Mayor seat can run the live Postgres
integration suite from inside its mask: localhost TCP crosses the mask, the
podman socket does not.

## Install (Overseer, once)

```bash
mkdir -p ~/.config/containers/systemd
cp -f db/quadlet/longburn-postgres.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start longburn-postgres.service
```

Survives reboots via `WantedBy=default.target` (quadlet generates the service
on daemon-reload; enablement is implicit in the [Install] section for
generated units — `systemctl --user status longburn-postgres.service` to
confirm).

## Running the live suite (any seat with localhost + psql, i.e. the Mayor)

```bash
# Fresh migrated database (drop/create keeps runs independent):
psql 'postgresql://longburn_test:longburn_test@127.0.0.1:5433/postgres' \
  -c 'DROP DATABASE IF EXISTS longburn_test' -c 'CREATE DATABASE longburn_test'
for f in db/migrations/*.sql; do
  psql 'postgresql://longburn_test:longburn_test@127.0.0.1:5433/longburn_test' -v ON_ERROR_STOP=1 -f "$f"
done

LONGBURN_TEST_DATABASE_URL='postgresql://longburn_test:longburn_test@127.0.0.1:5433/longburn_test' \
  npm test -- test/event-store.postgres.integration.test.mjs
```

## Lifecycle

- Stop: `systemctl --user stop longburn-postgres.service`
- Wipe data: stop, then `podman volume rm longburn-postgres-data` (host-side;
  the volume only ever holds disposable test databases)
- Logs: `journalctl --user -u longburn-postgres.service`
