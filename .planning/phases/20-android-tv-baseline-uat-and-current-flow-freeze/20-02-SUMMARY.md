# Plan 20-02 Summary: Current Flow Notes and Known Limitation Register

**Status:** Complete, awaiting user UAT
**Completed:** 2026-05-26

## Changes

- Documented that Android TV is the official TV playback path.
- Documented that Web TV is a debug client.
- Registered known current limitations in the Phase 20 UAT file and deferred them to Phase 21-24.
- Added Android TV baseline verification notes to `HomeKTV/README.md`.

## Evidence

```bash
rg -n "正式 TV 播放端|Web TV 调试|浏览器" docs/deployment.md HomeKTV/README.md
rg -n "Phase 21|Phase 22|Phase 23|Phase 24" .planning/phases/20-android-tv-baseline-uat-and-current-flow-freeze/20-UAT.md
```

## Result

Future v1.4 work can reference one clear boundary: Android TV is product, Web TV is debug.
