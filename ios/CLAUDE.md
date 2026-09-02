# Kept iOS - agent notes

A capture-and-confirm surface only. Domain logic belongs to the server, deliberately - see the root `CLAUDE.md`.

## Tests

- `xcodebuild test -project Kept.xcodeproj -scheme Kept -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:KeptTests`
- The same command with `-only-testing:KeptUITests` for the UI tests, which need a booted simulator and take about a minute.

## Shipping a build to TestFlight

Bump `CURRENT_PROJECT_VERSION` on the **Kept** target's Debug *and* Release configurations in `Kept.xcodeproj/project.pbxproj` - both plists read `$(CURRENT_PROJECT_VERSION)`, so nothing else needs editing, and the test targets are neither archived nor uploaded. TestFlight offers an update only when the `(CFBundleShortVersionString, CFBundleVersion)` pair strictly exceeds what is installed.

Then archive, and export with `destination=upload` to upload in the same step:

```
xcodebuild archive -project Kept.xcodeproj -scheme Kept -configuration Release \
  -destination 'generic/platform=iOS' -archivePath <path>.xcarchive
xcodebuild -exportArchive -archivePath <path>.xcarchive \
  -exportOptionsPlist <opts>.plist -exportPath <out> -allowProvisioningUpdates
```

The options plist is checked in as `ios/ExportOptions.plist` (2026-09-01): `method=app-store-connect`, `teamID=<team-id>`, `signingStyle=automatic`, `destination=upload`, `uploadSymbols=true`, and `manageAppVersionAndBuildNumber=false` - without the last, Xcode may rewrite the build number you just set. With `destination=upload` the export leaves **nothing** at `-exportPath`; to inspect the signed `.ipa`, export the same archive a second time with `destination=export` (a `sed` on that one key) and read that copy - it is a sibling of the uploaded bytes, not the bytes themselves, and say so when you record it.

**No App Store Connect API key is required, and the org has none** (Users and Access → Integrations offers only *Request Access*). `-allowProvisioningUpdates` mints cloud-managed distribution signing instead.

Four things that make a broken build look shippable:

- **`security find-identity -v -p codesigning` lists only "Apple Development"** even when cloud-managed distribution signing works. Its absence is not evidence that distribution signing is unavailable.
- **`xcodebuild archive` succeeds while producing a *development*-signed archive.** Distribution signing happens at **export**, not archive. `** ARCHIVE SUCCEEDED **` proves nothing about uploadability.
- Passing `CODE_SIGN_IDENTITY="Apple Distribution"` to `archive` **fails** - it conflicts with automatic signing. Do not override the identity; let export handle it.
- Verify the exported `.ipa`, never the exit code: `codesign -dvvv` must show `Authority=Apple Distribution`, and the embedded profile must have `get-task-allow=false` with **no** `ProvisionedDevices`.

`ITSAppUsesNonExemptEncryption=false` is already in `Kept/Info.plist`, so no export-compliance prompt gates the build. App Store Connect's web UI has no upload control - *Build Uploads* is a monitoring view; binaries arrive only via Xcode, Transporter, `altool` or the API. A new build joins the Internal Testers group on its own once processing completes.
