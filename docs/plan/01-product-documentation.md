# Stage 1: Align product documentation and copy

Status: **Prepared locally; checks passed; not deployed**.
Dependency: None.

## Scope and requirements

Update obsolete client-platform claims, mark historical fiat architecture as
superseded, separate provider operations from product documentation, and remove
provider branding from payment UI. Preserve runtime identifiers until a compatible
backend migration is implemented. Refresh the generated documentation index.

## Deliverables
- Current web-platform description across README, architecture and public guides.
- Provider-neutral product copy and separate internal provider operations guide.
- Historical fiat specifications clearly marked; generated MCP docs refreshed.

## Validation
Wallet and dashboard typechecks, documentation-index sync check, and diff checks
passed in the preceding stage. No deployment has been performed.

## Completion
- [x] Product copy and documentation aligned locally.
- [x] Existing SDK behavior distinguished from planned capabilities.
- [x] Documentation index refreshed.
- [ ] Publish through the normal release flow when releasing these changes.
