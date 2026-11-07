# Operating budget and cost reviews

The app is **100% free to its users**. The platform starts with an **administrator-adjustable $300 monthly allowance**, a separate **$30 safety margin**, and costly operations paused. Changing these settings creates no subscription, activates no paid provider, and changes no external provider account.

The dashboard supports operational decisions using recorded costs, retained commitments, and an explicit administrator cost review. It does not connect to provider invoices or independently verify total spending. Hosting, storage, database, network, tax and other external charges still need provider controls and reconciliation before the allowance can serve as a production spending ceiling.

## Administrator workflow

Only explicitly appointed platform administrators can view or change the operating budget. Project ownership does not grant this role. Follow [administrator setup](../apps/api/README.md#administrator-setup) to appoint the exact account ID using the trusted server and database configuration.

1. Set the monthly ceiling, safety margin and fixed-cost reserve. Include recurring infrastructure and subscription obligations in the reserve or recorded fixed costs. The safety margin is a fixed amount; raising the ceiling does not change it automatically.
2. Record invoices or corrections with a specific explanation. Fixed invoices consume the fixed reserve before adding to the total. Variable invoices are separate from integrated job charges; avoid entering the same charge twice.
3. Review the complete accounting and any unresolved estimates from earlier reviews. Enter an estimate for incurred but unreported costs, including reporting lag and earlier months. Exclude amounts already represented by recorded costs, the fixed allowance, or integrated reservations and settlements.
4. Enter low, expected and high amounts for **additional future variable spending** through the end of the current UTC month. Record the evidence and assumptions, the UTC time costs are covered through, and an explicit expiry. These are authored scenarios, not probabilities.
5. Confirm that the replacement review includes or reconciles all earlier unresolved estimates. Saving requires the exact accounting snapshot shown when the form was prepared. A changed snapshot requires refresh and review again.
6. Resume costly processing only when the policy, current cost review, headroom and workload-specific capacity are ready. Basic editing, cached results and prepared places remain available when new costly work is paused.

Policy updates use an explicit version. A refresh or cost entry preserves unsaved policy fields. If another administrator changes the policy, choose whether to retain the entered values for review or load the current settings; saving remains a separate action. Losing administrator access or changing account closes and clears the private dashboard, including pending responses.

## Exact accounting

All amounts use integer USD cents. The period is a UTC calendar month. The complete durable ledger, rather than the dashboard's recent-record preview, determines the totals.

```text
recorded spend = fixed invoices + variable invoices + settled operation costs
remaining fixed allowance = max(0, fixed reserve − fixed invoices)
known accounting = recorded spend + remaining fixed allowance + open maximum-cost reservations
accounted exposure = known accounting + latest unresolved unreported estimate
operating limit = monthly ceiling − safety margin
internal headroom = max(0, operating limit − accounted exposure)
```

A $50 fixed reserve with a $20 fixed invoice still accounts for $50, leaving $30 in the reserve. If variable invoices total $10, running reservations hold $15 and the cost review retains $5 of unreported costs, accounted exposure is $80. Under the default $300 ceiling and $30 margin, internal headroom is $190. This is an accounting example, not a measured infrastructure cost.

Negative manual entries are corrections or refunds, require a reason, and cannot make the complete fixed or variable category negative. Settled operations are recognized in the UTC month of reconciliation. Running reservations remain held across month boundaries until explicitly reconciled. Only undispatched reservations expire. A timeout never releases an unknown running charge.

The latest unreported estimate also remains held when its review expires, its evidence changes, or a new month begins. It is replaced only by an explicit subsequent review that acknowledges the previous review and all unresolved costs. This prevents stale information from restoring spendable capacity.

## Outlook and freshness

The versioned method is `budget-outlook-1.0.0`. For each low, expected and high scenario:

```text
captured scenario = known accounting at review + unreported estimate + authored future amount
displayed scenario = max(captured scenario, current accounted exposure)
```

New integrated commitments raise the live accounting floor. They do not automatically get added a second time on top of the original future allowance. These scenarios are conservative accounting views, not statistical forecasts, verified invoice bounds, or spending authorization.

The remaining daily allowance divides current internal headroom evenly across remaining UTC dates, counting today once. It is not extrapolated from ledger posting dates: an invoice posting date is not evidence of when its underlying usage occurred.

The form defaults to a 24-hour review, bounded by the end of the month. Administrators may choose an expiry no later than seven days after the covered-through time and no later than the next UTC month boundary. Coverage must be within the current UTC month and cannot be in the future. The server is authoritative for freshness.

| Change                                                                       | Result                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| No review, invalid review, expiry, or new UTC month                          | Withhold scenarios and require a new review before new costly work   |
| Manual cost correction/entry, changed fixed reserve, or settled cost overrun | Invalidate coverage and require a new review                         |
| Ordinary reservation, dispatch, normal settlement, or release                | Update accounting without invalidating otherwise current coverage    |
| Monthly ceiling, safety margin, or pause change                              | Recompute admission and warnings; preserve current cost coverage     |
| Any accounting snapshot change while submitting a review                     | Reject the stale submission; refresh and review the current snapshot |

Coverage and submission use separate hashes. The coverage hash tracks the manual ledger, fixed allowance and acknowledged overruns. The submission basis additionally captures policy, complete reservation details, exact accounting and the preceding review. Reviews are append-only and retain their author, timestamps, method, evidence hashes, estimates and explanation. Up to 10,000 reviews are supported; exceeding the bound rejects a new review rather than deleting history.

## Observed alerts and complete records

The dashboard shows a required review, carried estimate, exhausted operating limit, expected scenario above the operating limit, or high scenario above the monthly ceiling. Administrator dashboard reads and policy/cost/review writes retain an audit event when the observed alert state changes. Repeated observations of the same state do not add duplicate transitions.

These events describe what was observed during those interactions. There is **no background alert monitor, email notification or delivery guarantee**. Intermediate states between observations are unknown. Reading paginated records does not create alert events or invalidate its own pagination cursor.

The recent dashboard preview is supplemented by complete, newest-first history for adjustments, reservations, reviews and audit events, including earlier months and old running holds. Pages contain up to 50 complete records. Cursors bind the collection and its snapshot; a changed collection returns a conflict and requires loading the latest history instead of mixing snapshots. Expanded details retain all fields, including full explanations.

## Work admission and storage

New integrated reservations and actual dispatch both require a current review and available internal headroom. GIS, workforce, accessibility, traffic, public-source preparation and identity mail recheck their applicable budget conditions before starting work. An existing running task may still finish and reconcile its actual obligations after admission closes.

Bounded public-source preparation additionally requires `NATIONAL_CAPACITY_STATEMENT` and `NATIONAL_CAPACITY_ENVIRONMENT`. The environment is `local-development` outside production, or `deployment`. Deployment capacity requires recorded or reserved fixed infrastructure costs. The preparation flag alone is insufficient. Missing or changed evidence prevents a new source attempt; an already queued attempt can fail as retryable without consuming source quota, then resume after an explicit review and retry. Already prepared bundles remain available. The trusted one-time preparation CLI remains an operator tool and is not the visitor admission path.

SQLite guards and PostgreSQL migration **018** preserve review, audit, manual ledger and reservation history under runtime roles. Existing migrations 001–017 are unchanged. Worker scopes may read the evidence they require; preparation has no budget write authority. Review and policy writes remain administrator operations. PostgreSQL migrations run only through the separate operator connection, never through application startup. See [storage operations](STORAGE.md).

The accounting record is global and independent of project content. Exact cents, immutable history and protected admission are useful local controls; provider metering, invoice adapters, distributed notification delivery, external hard limits, production capacity evidence and operational recovery remain separate launch work.
