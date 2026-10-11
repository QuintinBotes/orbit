# 0005. Fixes for the first independent security review

Status: accepted (2026-10-05)

An adversarial review by Codex (gpt-6.1-sol) of the policy, isolation,
adapter, delivery and controller modules reported one critical, six high and
one medium defect. Each decision below closes one of them; each fix ships
with a test that fails on the old code.

1. **Parallel integration wrote through symlinks.** Work units are integrated
   with `git apply --index` against the integration worktree, which refuses
   to write beyond a symbolic link, and the integrated tree is inspected with
   `policy.inspectScope` before it is accepted. A unit that adds a symlink
   whose target leaves the repository is rejected before integration. No
   integration path writes through the filesystem as the controller.

2. **External actions were not fenced by the lease.** Starting an attempt
   asserts the caller's lease inside the same transaction that moves the
   action to EXECUTING and records the executor and its start time. Another
   owner that finds an EXECUTING action does not start a new attempt until
   the action's deadline has passed and reconciliation confirms the effect
   is absent. A controller that has lost its lease starts no further action.

3. **Worker shells could read credentials.** Preflight refuses a repository
   whose git configuration (local or common) carries credential material:
   userinfo in remote URLs, `http.*.extraheader` authorization values, or a
   credential store inside the repository. Credential files present in the
   worktree (built-in credential patterns and protected credential globs) go
   on the worker's OS read-deny list. Bash commands that statically read a
   protected credential path are denied as an extra, advisory layer.

4. **Worker output was stored unredacted.** The shim pipes provider stdout
   and stderr through the policy redactor, line by line, before writing
   `log.jsonl` and `stderr.log`. Replacement text contains no quote or
   backslash, so JSON lines stay valid.

5. **Additional push URLs escaped authorization.** Delivery reads every push
   URL (`git remote get-url --push --all`), refuses a remote with more than
   one push URL or any URL outside the authorized destination, and pushes to
   the validated URL itself rather than to the remote name.

6. **Large files skipped the secret scan.** Files above the gitleaks input
   limit are scanned by the built-in detector in streaming chunks. A file
   that cannot be scanned at all makes the scan incomplete, and an incomplete
   scan blocks delivery unless policy lists the path as an exception.

7. **Approve-once widened worker permissions.** A grant never widens the
   worker's sandbox, hook policy or action flags. The controller executes
   exactly the approved command itself, in isolation, records it as an
   action, and gives the worker the result as an artifact.

8. **CI checks could be attributed to the wrong revision.** Checks are read
   per commit (`repos/{owner}/{repo}/commits/{sha}/check-runs` and the
   combined status) and labelled with the SHA the response reports.

## Amendments after the independent re-review (2026-10-05)

A second review confirmed five of the eight fixes and found four of them
incomplete, plus one new defect. The decisions above stand; these close the gaps.

3. **Credential read-deny.** "Protected credential globs" are the built-in
   credential globs plus every protected glob of the policy that names credential
   material (`secrets/**`, `config/*.key`; whole-word match on `secret`,
   `credential`, `password`, `api_key`, `private_key` or an extension such as
   `.key`, `.pem`, `.env`). `.github/**` and `infra/**` are protected for writing
   only and stay readable. One list (`credentialGlobsOf`) feeds the Read tool, the
   Bash read classifier, the Claude settings and the OS read-deny enumeration.
   The enumeration walks `node_modules`, and when it exceeds its traversal cap it
   fails closed: the worker (or check) profile build refuses with
   `ISOLATION_UNAVAILABLE` rather than return a partial list.
4. **Multi-line secrets in worker output.** The line sink keeps one piece of
   state per stream: on a `-----BEGIN ... PRIVATE KEY-----` line it writes one
   `[REDACTED:private-key]` marker and drops every line through the matching END
   line. With no END within 200 lines it keeps dropping until the stream ends and
   writes one more marker line saying so. A complete JSON line never opens a block.
6. **Scan completeness.** An `unscannable-file` finding that no policy exception
   waives blocks and makes the scan incomplete whatever `block_severities`
   lists. The large-file tests place the secret beyond the old 8 MiB capture.
8. **CI status pagination.** Every page of the combined status is read. Its
   aggregate state and `total_count` judge the read: an aggregate of failure or
   error with no failing check becomes a failing check, fewer contexts read than
   `total_count` (also for check runs) becomes a pending check, and an aggregate
   other than success with no pending context becomes a pending check. A partial
   read can no longer produce a passed result.

Explicit credential paths (architect decision): `scope.credential_paths` lists
credential locations a repository adds, and it is authoritative. The
name-based reading of `protected_paths` above remains only as a fallback for
configurations that predate the key.
