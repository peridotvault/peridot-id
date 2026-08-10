# Peridot ID V3 — PRD & Repository Audit Task

## Context

Peridot ID is an identity and authentication service.

The previous version focused on identity and authentication. V3 expands the product scope into:

1. Identity
2. Authentication
3. Wallet

For V3, the initial authentication provider is **Google OAuth**.

V3 should also introduce a wallet associated with a Peridot ID.

However, **do not assume a specific wallet architecture, Account Abstraction implementation, custody model, key-management model, blockchain implementation, SDK, or third-party provider yet.**

The existing repository must be audited first.

Your job as the AI coding agent is to:

1. Audit the existing Peridot ID repository.
2. Understand the current architecture and implementation.
3. Identify what already exists and must be preserved.
4. Identify gaps between the current implementation and this V3 PRD.
5. Propose an implementation architecture based on the actual repository.
6. Only then implement the required changes.

Do not invent existing functionality.
Do not assume an architecture that is not supported by the repository.
Do not blindly follow assumptions from this document when repository evidence contradicts them.

---

# 1. V3 Goal

Peridot ID V3 should become an identity system where a Peridot ID can authenticate users and be associated with a wallet.

The conceptual relationship is:

```text
Authentication
      │
      ▼
Peridot ID
      │
      └────── Wallet
```

The wallet belongs to the Peridot ID.

Authentication providers are credentials used to authenticate the Peridot ID.

A wallet must NOT be conceptually tied directly to a specific OAuth provider.

For example:

```text
Google
   │
   ▼
Credential
   │
   ▼
Peridot ID
   │
   ▼
Wallet
```

Not:

```text
Google
   │
   ▼
Wallet
```

The exact implementation must be determined after auditing the repository.

---

# 2. Scope

V3 consists of three major domains.

## 2.1 Identity

Peridot ID remains the canonical identity.

The PID must remain immutable.

The identity system must continue to support the existing identity rules unless the repository audit identifies a conflict that requires an explicit architectural decision.

---

## 2.2 Authentication

V3 initially supports:

```text
Google OAuth
```

The authentication system must:

- authenticate users through Google
- resolve the Google credential to a Peridot ID
- create an authenticated session
- preserve the existing identity uniqueness rules
- allow the identity to exist independently from a specific OAuth provider

Do not add Apple, Discord, Steam, wallet login, email/password, or other providers unless they already exist and are required for backward compatibility.

V3 is intentionally starting with Google.

---

## 2.3 Wallet

A Peridot ID can have an associated wallet.

The exact wallet architecture must NOT be assumed before repository audit.

The agent must investigate and determine the appropriate implementation based on:

- current codebase
- current database model
- existing dependencies
- current authentication architecture
- existing blockchain integrations
- security model
- deployment architecture
- existing product decisions
- maintainability

The agent should explicitly identify the available architectural options before selecting one if the repository does not make the answer obvious.

---

# 3. Fundamental Relationship

The intended domain relationship is:

```text
PID
├── Credentials
│   └── Google
│
└── Wallet
```

The wallet is associated with the PID.

The OAuth provider is a credential for authenticating the PID.

Therefore:

> Unlinking Google must not inherently delete, recreate, or detach the wallet from the PID.

If Google is removed while another valid authentication method exists, the PID and its wallet must remain intact.

Example:

```text
Before:

PID
├── Google
└── Wallet A


After unlinking Google:

PID
└── Wallet A
```

The exact mechanics of unlinking must be determined from the existing authentication implementation and security model.

---

# 4. Existing Identity Rules

The following rules are already established and MUST be preserved unless the repository audit demonstrates that the current implementation differs and requires migration.

## Provider identity uniqueness

```text
(provider, providerUserId) = unique
```

The same provider account cannot belong to multiple PIDs.

---

## Email uniqueness

An email can only be associated with one PID.

If a new OAuth login returns an email already associated with another PID:

```text
DO NOT automatically merge identities.
DO NOT automatically move the credential.
DO NOT create a second PID for the same email.
```

The operation should be rejected according to the existing identity-linking rules.

The user must explicitly resolve the existing identity association.

---

## PID immutability

A PID is immutable.

The PID itself must not change when:

- authentication providers are added
- authentication providers are removed
- wallet information changes
- the user changes devices
- the user authenticates through another supported credential

---

## Credential unlinking

A user must not be allowed to remove the final authentication credential if that would leave the PID without any valid authentication mechanism.

The exact enforcement mechanism should follow the existing repository architecture.

---

# 5. Wallet Ownership

The intended product behavior is:

```text
Wallet → belongs to PID
```

Not:

```text
Wallet → belongs to Google
```

The implementation should allow the authentication mechanism to evolve independently from the wallet.

For example, conceptually:

```text
Google ──┐
         │
         ▼
        PID
         │
         ▼
      Wallet
```

If another authentication provider is introduced in the future:

```text
Google ──┐
Apple  ──┤
         ▼
        PID
         │
         ▼
      Wallet
```

The wallet should continue to represent the same wallet associated with that PID.

This is a product requirement, not an instruction to use a specific technical implementation.

---

# 6. Account Abstraction

Account Abstraction has been identified as a potentially relevant concept for the wallet architecture.

However:

**Do not assume that V3 must use a particular Account Abstraction standard or implementation.**

The agent must investigate the repository and determine whether AA is relevant and, if so:

- where it belongs
- what problem it solves
- whether it should be implemented in V3
- whether it should be abstracted behind the wallet domain
- whether an external service/provider is appropriate
- whether the existing blockchain stack supports it

Do not introduce ERC-4337, smart accounts, session keys, paymasters, MagicBlock, or another specific technology solely because they are mentioned in this PRD.

Those are architectural possibilities to investigate, not requirements.

---

# 7. Blockchain Scope

The repository should be audited to determine the currently intended blockchain scope.

If the existing project already contains blockchain-related implementation or decisions, preserve and build upon them where appropriate.

If the repository does not provide enough evidence to determine the correct wallet architecture:

**stop and document the architectural decision that requires clarification rather than inventing one.**

Do not expand V3 into multi-chain wallet support unless required by existing project context or explicitly justified by the audit.

---

# 8. Wallet Lifecycle

The agent must audit and design the lifecycle of a wallet associated with a PID.

At minimum, investigate:

### Wallet creation

When and how is a wallet created?

Potential possibilities include:

```text
during signup
during first login
on explicit user action
lazily on first wallet-required operation
```

Do not assume one.

---

### Wallet retrieval

A PID should be able to retrieve its associated wallet through the Peridot ID system.

---

### Wallet persistence

The wallet association must survive:

- OAuth provider changes
- authentication credential unlinking
- login from another device
- session expiration
- normal account lifecycle operations

---

### Wallet deletion

Determine whether wallet deletion is possible.

If the wallet is blockchain-backed, investigate the implications carefully.

Do not implement destructive wallet deletion merely because the database supports deleting a row.

---

### PID deletion

Determine what happens to the wallet when a PID is deleted.

This must be explicitly documented.

A blockchain wallet may have an on-chain lifecycle that differs from the lifecycle of the identity record.

Do not invent a recovery or deletion mechanism without repository evidence and architectural analysis.

---

# 9. Security Requirements

Wallet functionality introduces significantly higher security requirements than ordinary authentication.

The audit must specifically investigate:

- private key handling
- secrets management
- server-side signing
- client-side signing
- authentication-to-wallet authorization boundaries
- session security
- replay protection
- wallet creation authorization
- wallet recovery
- account takeover scenarios
- OAuth account takeover scenarios
- unlink/relink attacks
- database compromise implications
- credential compromise implications
- wallet compromise implications

The implementation must not expose private keys or sensitive signing material through normal API responses.

If the existing architecture cannot safely support the proposed wallet architecture, document the issue before implementation.

---

# 10. API / SDK

Audit the existing API and SDK architecture before designing new endpoints.

V3 may require functionality for:

- authentication
- session retrieval
- wallet retrieval
- wallet creation
- wallet status
- wallet-related authorization

But the exact endpoints, GraphQL operations, RPC methods, SDK interfaces, and response schemas must be based on the existing project architecture.

Do not introduce REST if the project is GraphQL-first.

Do not introduce GraphQL if the project is REST-first.

Follow the repository.

---

# 11. Database

Audit the current schema first.

Determine:

- existing identity tables
- existing provider/credential tables
- existing sessions
- existing wallet-related tables
- existing constraints
- existing indexes
- existing migrations

Then design the minimum schema changes required for V3.

The schema should represent the domain relationship clearly:

```text
PID
 ├── Credentials
 └── Wallets
```

Do not duplicate provider information inside wallet records unless there is a concrete architectural reason.

Do not store redundant identity information without justification.

---

# 12. Backward Compatibility

Existing V2 users must not unexpectedly lose:

- PID
- username
- identity
- authentication credentials
- sessions where appropriate
- existing account relationships

The migration path from the existing version to V3 must be documented.

If wallet creation for existing users is required, determine the safest migration strategy.

Do not silently create wallets for existing users if doing so has security, cost, custody, or blockchain implications.

---

# 13. Repository Audit — Required Before Coding

Before making code changes, perform a complete audit.

Inspect at minimum:

```text
README
package manifests
workspace configuration
application structure
authentication implementation
OAuth implementation
identity models
database schema
database migrations
session implementation
API layer
SDK/client packages
configuration
environment variables
security-sensitive modules
tests
deployment configuration
existing blockchain dependencies
existing wallet code
```

Also inspect git history when useful to understand why important architectural decisions were made.

---

# 14. Audit Output

Before implementation, produce a concise architecture audit containing:

## Current Architecture

Explain how the current Peridot ID implementation actually works.

## Existing Identity Model

Explain:

- PID representation
- provider credentials
- email handling
- uniqueness
- unlink behavior
- sessions

## Existing Wallet Capability

State clearly whether wallet functionality currently exists.

If it exists:

- explain how it works
- identify dependencies
- identify limitations

If it does not exist:

- explicitly state that.

## V3 Gap Analysis

List:

```text
Already exists
Needs modification
Needs new implementation
Needs architectural decision
```

## Architecture Proposal

Based on the repository, propose the smallest coherent architecture that satisfies this PRD.

Do not over-engineer.

## Risks

Identify:

- security risks
- migration risks
- data integrity risks
- wallet custody risks
- authentication risks
- operational risks

## Open Decisions

List decisions that cannot responsibly be made from the repository alone.

---

# 15. Implementation Principles

Follow these principles:

### Repository-first

The repository is the source of truth for the current implementation.

### Minimal change

Do not rewrite working systems without a concrete reason.

### No speculative infrastructure

Do not introduce infrastructure merely because it might be useful in the future.

### No unnecessary abstraction

Only introduce abstractions that solve a current V3 requirement or are clearly required by the existing architecture.

### Security over convenience

Wallet functionality must not weaken the authentication security model.

### Identity independence

Authentication provider and wallet must remain conceptually independent.

### Backward compatibility

Existing identities should continue working after V3.

### Explicit decisions

When the repository does not provide enough information, document the uncertainty rather than guessing.

---

# 16. Definition of Done

V3 is considered complete when:

### Identity

- Existing PID behavior remains intact.
- PID remains immutable.
- Existing provider uniqueness rules remain enforced.
- Email uniqueness rules remain enforced.
- Existing identity-linking rules remain enforced.

### Authentication

- Google OAuth works.
- Google resolves to the correct PID.
- Sessions work according to the existing session architecture.
- Credential unlinking follows the established security rules.

### Wallet

- A wallet can be associated with a PID.
- Wallet ownership is represented as a relationship to the PID.
- Wallet association does not depend directly on Google.
- Removing an authentication provider does not inherently remove the wallet.
- Wallet lifecycle is explicitly defined.
- Sensitive wallet material is protected.
- Wallet operations are authorized through the appropriate authentication/session mechanism.

### Engineering

- Existing tests continue to pass.
- New V3 behavior has appropriate tests.
- Database migrations are safe.
- API/SDK changes follow existing project conventions.
- Documentation is updated.
- No unnecessary dependencies or infrastructure are introduced.

---

# 17. Important Instruction to the AI Agent

Do NOT start by coding.

First:

```text
AUDIT
  ↓
UNDERSTAND
  ↓
GAP ANALYSIS
  ↓
ARCHITECTURE PROPOSAL
  ↓
IDENTIFY OPEN DECISIONS
  ↓
IMPLEMENT
  ↓
TEST
  ↓
DOCUMENT
```

The purpose of this PRD is to define **what Peridot ID V3 must accomplish**, not to dictate every technical implementation detail.

Use the actual repository to determine **how** it should be implemented.

When a technical decision is ambiguous, explain the options and choose the smallest solution that is consistent with the existing architecture, or flag it for clarification if the decision has significant security, custody, financial, or irreversible consequences.

Do not make assumptions about technologies that have not been established by the repository.
