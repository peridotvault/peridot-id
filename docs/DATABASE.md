# Database

Tables:
- identities
- auth_accounts
- profiles
- devices
- sessions

ERD:
```text
identities 1--* auth_accounts
identities 1--1 profiles
identities 1--* devices 1--* sessions
```
