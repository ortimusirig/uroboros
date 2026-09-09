# Authentic native pre-integration test source

`native-preintegration-3051ccb.tar.gz` is an immutable source fixture from Uroboros commit `3051ccbe52d84dd7a93d80604e4230d089421038`, before workflow-profile integration. It contains the exact Git archival bytes of `src/`, `package.json`, and the original MIT `LICENSE` (80 regular files). No bindings, metadata, behavior, or source were removed or synthesized. It is test-only historical code, not an installed runtime or a fallback for current code.

Generated once, offline, from the available authentic source object:

```powershell
git archive --format=tar.gz --output=test/fixtures/native-preintegration-3051ccb.tar.gz 3051ccbe52d84dd7a93d80604e4230d089421038 src package.json LICENSE
```

Archive: 321746 bytes; SHA-256 `513463b5c25b1ac0f2d65de11c8b5a6e86167f83dd1ce6c9d0bdfafbb0db85cc`.

The adjacent inventory records each file's source Git blob, byte length, and SHA-256. At introduction, an independent fresh `git archive` was compared byte-for-byte with this artifact; every extracted file was compared byte-for-byte with `git show SOURCE_COMMIT:PATH`, and the extracted file set was compared with `git ls-tree -r SOURCE_COMMIT src package.json LICENSE`: all 80 matched, without extra files. The exact original license is retained inside the archive and extracted with the source.

Normal tests need no Git history, repository metadata, network download, or new dependency to acquire the fixture. The helper reads this checked-in artifact relative to itself, verifies the pinned SHA-256, then sends those same verified bytes to the existing system `tar` extraction tool. Missing/corrupt artifacts refuse; they never trigger fetching, regeneration, skipping, or substitution of current source. Existing native execution scenarios still use Git normally for their disposable target repositories; they no longer need this historical source object.

Keep the archive and inventory immutable. Any deliberate new historical baseline should receive its own artifact/name/provenance and an explicit reviewed helper update. Do not regenerate this artifact during tests or silently update its integrity pin.
