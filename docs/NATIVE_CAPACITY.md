# Shared native processing capacity

Traffic simulation, GIS conversion, regional routing and media rendering share one
durable processing slot. A worker claims the slot in the same database transaction
that consumes a job attempt. Independent worker processes cannot each start their
own expensive operation. Existing fixed-cost declarations and budget checks still
apply; this slot does not measure or settle provider charges.

The slot records its service, job, worker, random fencing token, heartbeat and
fixed hard deadline. Heartbeats never extend that deadline. An expired heartbeat
or deadline **quarantines** the slot; it never transfers ownership automatically.
The consumed attempt remains in the job history, including after cancellation.

GIS, SUMO and media kill their entire named container and verify that Docker reports it
absent before releasing capacity. A Docker daemon error is uncertainty and leaves
capacity quarantined. Workforce and outbound accessibility routing use a persistent native HTTP service:
aborting an HTTP request does not prove that service stopped computing. A failed
or cancelled dispatched routing call therefore quarantines capacity. Successful
completed requests release it normally. Other requests can remain queued, but
no native work starts while the slot is occupied or quarantined.

Native source profiles, containers and their CPU/memory/runtime bounds remain
separate from the slot. The slot is an admission and crash-recovery fence; it is
not a replacement for process termination or a production cost guarantee.

### Source correspondence verification capacity

The optional Census commute source-geometry verifier is a pure retained-file
worker, separate from the durable native slot. One API process admits one fresh
asset verification and at most two waiting loads; identical concurrent requests
share the same work. Geometry replay has a 60-second deadline and a 1 GiB V8
old-generation heap setting, which does not cap total process RSS. Failed or
changed evidence is never cached as accepted.

The 660-route packaging measurement took 13.63 seconds and reached 1,425,408 KiB
whole-process peak RSS. A separate cold catalog check took 13.665 seconds;
cached access took 0.473 milliseconds and a fresh dependency rehash with replay
cache reuse took 4.506 seconds. That process peaked at 1,443,920 KiB RSS. These
are local measurements of catalog operations, not full HTTP/render latency or a
production capacity guarantee. A verifier can coexist with a
2 GiB native run, and separate API processes have separate verification queues.
Deployment sizing must include both plus application/database overhead. A shared
cross-process verification admission limit and production load measurements
remain operational work. This implementation does not increase the $300/month
administrator-controlled operating allowance or activate a paid provider.

## Operator recovery

There is no browser recovery override. Use a trusted operator connection after:

1. Stopping the affected application workers so an old worker cannot resume.
2. Confirming all GIS/SUMO/media job containers are absent. For uncertain workforce
   work, confirm the dedicated routing service is idle or restart that dedicated
   service, without affecting unrelated containers.
3. Inspecting the retained token and revision, then recording exactly what was
   stopped and how termination was confirmed.

```sh
node_modules/.bin/tsx scripts/native-capacity.ts --inspect \
  --database-file /explicit/private/path/api-state.json

node_modules/.bin/tsx scripts/native-capacity.ts --recover \
  --database-file /explicit/private/path/api-state.json \
  --token EXACT_TOKEN --revision EXACT_REVISION --operator OPERATOR_NAME \
  --confirmation 'All affected workers stopped; named job containers absent; dedicated routing service restarted and idle.' \
  --all-native-processing-confirmed-stopped
```

For PostgreSQL omit `--database-file` and supply `DATABASE_MIGRATION_URL` through
the operator environment. Web, auth and worker credentials cannot perform
operator recovery or modify its audit history. SQLite inspection opens the existing database in read-only mode; it refuses an uninitialized target. PostgreSQL tooling requires the configured migration role and rejects application credentials. The CLI never restarts services,
changes budgets, runs migrations or retries jobs. A stale token/revision fails
without changing capacity. Recovery retains an append-only operator statement;
the user must still explicitly retry an interrupted job.

Upgrades with previously running native jobs start quarantined. Original JSON,
captured source bundles and existing graph identities remain unchanged.
