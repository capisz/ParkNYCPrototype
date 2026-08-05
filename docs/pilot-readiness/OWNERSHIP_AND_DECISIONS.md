# Ownership and decision log

## Proposed operating ownership

These assignments require written agency acceptance before production:

| Responsibility | Accountable owner | Required collaborators |
|---|---|---|
| Product, curb rules, geometry, and public parking guidance | NYC DOT | OTI, Law, accessibility, borough operations |
| Hosting, cybersecurity, privacy, platform, and incident process | NYC OTI | DOT product/data teams |
| Garage and parking-lot license data | NYC DCWP | DOT, OTI |
| Transit feeds, licensing, protected assets, and rider-status links | MTA | DOT, OTI |

## Decision log

| ID | Decision | State | Owner/evidence needed |
|---|---|---|---|
| D-001 | Street Pavement Ratings centerlines are not authoritative curb-side geometry and are excluded from the public viewport. A separate official meter-blockface layer is reference-only and never recommendation-eligible; green is limited to intervals completely resolved by fresh linked sign records plus a recognized meter schedule. | Enforced, approval pending | DOT-approved geometry and side-linkage record plus zero-false-green field audit |
| D-002 | Green requires complete supported evidence over the entire interval; absence of a restriction is not permission. | Enforced | DOT rule-catalog approval |
| D-003 | DCWP facilities are a license directory only; no price, capacity, reservation, or availability claim. | Enforced | DCWP data-steward sign-off |
| D-004 | Public service is anonymous; accounts, saved trips, payments, enforcement, and camera scanning are out of scope. | Enforced | Product/privacy approval |
| D-005 | Transit is disabled until isolated OTP routing, MTA agreements, realtime lag handling, return-trip validation, and accessibility gates pass. | Enforced | MTA/OTI/DOT sign-off |
| D-006 | Pidge is a secondary explainer. City identity, policy text, and posted-sign guidance carry authority. | Enforced | NYC brand approval before official-release header is enabled |
| D-007 | Exact origins, destinations, coordinates, and query strings are excluded from application logs and analytics. | Enforced in API logs | OTI privacy and analytics approval |
| D-008 | Current deployment identifies itself as a prototype; the official-City header is release-pipeline gated. | Enforced | Final agency authorization |

Every approval must identify approver, date, evidence URL, expiration/review date, and affected source or interpretation version. The database `data_stewardship_decisions` table is the machine-readable authority record for data decisions.
