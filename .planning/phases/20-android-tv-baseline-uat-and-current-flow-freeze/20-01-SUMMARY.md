# Plan 20-01 Summary: Baseline UAT Checklist and Verification Commands

**Status:** Complete, awaiting user UAT
**Completed:** 2026-05-26

## Changes

- Added baseline automated verification commands to `docs/deployment.md`, including `pnpm db:migrate` before runtime checks.
- Added a real Android TV UAT flow to `docs/deployment.md`.
- Created `.planning/phases/20-android-tv-baseline-uat-and-current-flow-freeze/20-UAT.md` with pending user verification.

## Evidence

```bash
rg -n "基线自动验证|pnpm db:migrate|pnpm -F @home-ktv/api typecheck|:app:testDebugUnitTest :app:assembleDebug" docs/deployment.md
rg -n "真实 Android TV 基线验证|原唱/伴唱|音量|重新打开控制器" docs/deployment.md .planning/phases/20-android-tv-baseline-uat-and-current-flow-freeze/20-UAT.md
```

## Result

The user now has a copyable baseline flow for real Android TV verification before future productization changes.
