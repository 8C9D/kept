# Kept iOS - agent notes

A capture-and-confirm surface only. Domain logic belongs to the server, deliberately - see the root `CLAUDE.md`.

## Tests

- `xcodebuild test -project Kept.xcodeproj -scheme Kept -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:KeptTests`
- The same command with `-only-testing:KeptUITests` for the UI tests, which need a booted simulator and take about a minute.
