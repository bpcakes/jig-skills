#!/usr/bin/env node
// Trusted runtime entry point. Model and repository commands are launched only
// by the controller's pinned executionBoundary, never by this adapter directly.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { answer, createRun, reconcileUpstream, release, runUntilBoundary, status } from "./review-fix-loop.mjs";
import { withControllerLease } from "./controller-lease.mjs";
import { parseArgs } from "./loop-options.mjs";
import { hash, json, loadRun, locked, save } from "./run-store.mjs";
import { groupRunning, ownedAlive } from "./process-ownership.mjs";
import { sameContent, snapshot } from "./repository.mjs";
import { checkoutDirty } from "./round-commits.mjs";
import { captureFingerprint } from "../../panel-review/scripts/scope-fingerprint.mjs";
import { assertCompleteFingerprint } from "../../panel-review/scripts/adapter-runtime.mjs";
import { withEnforcedGit, withGitLease } from "../../panel-review/scripts/git-lease.mjs";

const [file, digest, mode] = process.argv.slice(2);
await withEnforcedGit(async () => {
try {
  const raw = readFileSync(file);
  if (createHash("sha256").update(raw).digest("hex") !== digest) throw new Error("Controller manifest changed.");
  const manifest = JSON.parse(raw);
  if (manifest.schema !== 1 || !["preflight", "run", "answer", "adopt", "upstream-preflight", "reconcile-upstream", "release", "source"].includes(mode)) throw new Error("Unsupported controller invocation.");
  const args = { cwd: manifest.workspace, contract: manifest.contract, options: parseArgs(manifest.options),
    config: manifest.config, id: manifest.id };
  if (!args.config.executionBoundary || hash(args.config.orchestrationBinding) !== hash(manifest.binding)) throw new Error("Missing controller boundary or operation binding.");
  if (mode === "adopt") {
    const previous = manifest.adoption?.previous;
    if (!Array.isArray(previous) || !previous.length) throw new Error("Controller adoption requires its previous binding.");
    const activeFile = path.join(path.dirname(manifest.directory), "active.json");
    const active = existsSync(activeFile) ? JSON.parse(readFileSync(activeFile, "utf8")) : null;
    if (!existsSync(path.join(manifest.directory, "run.json")) || active?.directory !== manifest.directory) {
      await createRun({ ...args, adoptInitialization: previous });
    }
    const original = loadRun(manifest.directory);
    const config = { ...original.config, executionBoundary: args.config.executionBoundary,
      orchestrationBinding: manifest.binding };
    await withControllerLease({ ...original, config }, async () => {
      // The new owner holds the source lease while the original controller's
      // applicability checks validate a history change. No reports are rebound.
      const upstream = manifest.adoption.upstream_receipt;
      if (upstream !== undefined) await reconcileUpstream(original.directory, upstream, { preflightOnly: true });
      return locked(original.runsRoot, async () => {
      const run = loadRun(manifest.directory);
      const active = JSON.parse(readFileSync(path.join(run.runsRoot, "active.json"), "utf8"));
      if (run.id !== manifest.id || realpathSync(run.root) !== realpathSync(manifest.workspace)
          || run.contractHash !== hash(manifest.contract) || active.directory !== run.directory) throw new Error("Controller adoption changed its source, contract or active ownership.");
      const matches = binding => hash(run.config.orchestrationBinding) === hash(binding.binding)
        && hash(run.config.executionBoundary) === hash(binding.boundary);
      const adopted = matches({ binding: manifest.binding, boundary: config.executionBoundary });
      if (!adopted && !previous.some(matches)) throw new Error("Controller ownership differs from the saved adoption transaction.");
      if (run.phase === "CONVERGED" && upstream === undefined) {
        const fingerprint = await captureFingerprint(run.args);
        assertCompleteFingerprint(fingerprint);
        const source = snapshot(run.root, undefined, { maxBytes: run.config.storage.maxSourceBytes });
        if (fingerprint.fingerprint !== run.fingerprint.fingerprint || !sameContent(source.files, run.expected.files)) throw new Error("Converged controller source changed before adoption; retain its historical result and reconcile the source.");
      }
      const assignments = path.join(run.directory, "assignments");
      for (const name of existsSync(assignments) ? readdirSync(assignments) : []) {
        const directory = path.join(assignments, name);
        for (const file of ["claimed", "child.json"]) {
          const stored = path.join(directory, file);
          if (!existsSync(stored)) continue;
          const owner = JSON.parse(readFileSync(stored, "utf8"));
          if (ownedAlive(owner) || file === "child.json" && groupRunning(owner)) throw new Error("Previous assignment processes have not settled; retry adoption after settlement.");
        }
        const launches = path.join(directory, "launch.json");
        if (existsSync(launches)) {
          const last = JSON.parse(readFileSync(launches, "utf8")).at(-1);
          if (ownedAlive(last?.owner) || last && !last.owner && Date.now() < last.deadlineAt) throw new Error("Previous assignment startup has not settled.");
        }
      }
      if (!adopted) {
        const previousOwner = run.config.orchestrationBinding.owner_session;
        // Session rotation changes who may run the controller, not the pinned
        // review policy. Keep its original authority fields for policy hashing;
        // execution still uses the newly checked boundary below.
        run.orchestrationReviewAuthority ??= {
          executionBoundary: run.config.executionBoundary,
          orchestrationBinding: run.config.orchestrationBinding,
        };
        run.config = { ...run.config, executionBoundary: config.executionBoundary, orchestrationBinding: manifest.binding };
        save(run, "orchestration-owner-adopted", { previousOwner, owner: manifest.binding.owner_session });
      }
      });
    });
    process.stdout.write(JSON.stringify({ adopted: true, controller_id: manifest.id }));
  } else if (mode === "preflight") {
    const result = await createRun({ ...args, preflightOnly: true });
    if (path.join(result.runsRoot, manifest.id) !== manifest.directory) throw new Error("Controller storage differs from the pinned private Git directory.");
    process.stdout.write(JSON.stringify({ preflight: true, fingerprint: result.fingerprint.fingerprint }));
  } else {
    let run;
    const activeFile = path.join(path.dirname(manifest.directory), "active.json");
    const active = existsSync(activeFile) ? JSON.parse(readFileSync(activeFile, "utf8")) : null;
    if (existsSync(path.join(manifest.directory, "run.json")) && active?.directory === manifest.directory) {
      run = loadRun(manifest.directory);
      if (run.id !== manifest.id || realpathSync(run.root) !== realpathSync(manifest.workspace)
          || hash(run.config.orchestrationBinding) !== hash(manifest.binding)
          || hash(run.config.executionBoundary) !== hash(manifest.config.executionBoundary)
          || run.contractHash !== hash(manifest.contract)) throw new Error("Existing controller does not match this operation.");
    } else if (mode === "run") {
      run = await createRun(args);
    } else {
      throw new Error("Cannot answer a controller that has not started.");
    }
    if (mode === "source") {
      // The host already holds the checkout lease. Retain it in every Git child;
      // acquiring a second controller lease here would deadlock the caller.
      const fd = Number(process.argv[5]);
      if (!Number.isSafeInteger(fd) || fd < 3 || run.phase !== "CONVERGED") throw new Error("Source inspection requires a held lease and a converged controller.");
      const result = await withGitLease({ fd, root: run.root }, async () => {
        // Snapshot reads every included file, including entries hidden from
        // status by index flags, and confines diff refreshes to a private index.
        const source = snapshot(run.root, undefined, { maxBytes: run.config.storage.maxSourceBytes });
        const head = source.repositories[""].head;
        return { head, clean: head === run.fingerprint.headOid
          && sameContent(source.files, run.expected.files) && !checkoutDirty(run.root) };
      });
      process.stdout.write(JSON.stringify(result));
    } else if (mode === "release") {
      const result = await withControllerLease(run, () => release(run.directory, manifest.workspace));
      process.stdout.write(JSON.stringify(result));
    } else if (mode === "upstream-preflight") {
      await reconcileUpstream(run.directory, JSON.parse(readFileSync(0, "utf8")), { preflightOnly: true });
      process.stdout.write(JSON.stringify({ preflight: true, controller_id: run.id }));
    } else if (mode === "answer") {
      const response = JSON.parse(readFileSync(0, "utf8"));
      await withControllerLease(run, async () => {
        const existing = run.answers.find(item => item.questionId === response.question_id);
        if (existing) {
          if (existing.answer !== response.answer) throw new Error("Question already has a different answer.");
        } else {
          if (!run.waitingForAnswer || run.questions.at(-1)?.id !== response.question_id) throw new Error("Question does not match the pending controller question.");
          await answer(run.directory, response.answer);
        }
      });
      process.stdout.write(JSON.stringify({ accepted: true, question_id: response.question_id, controller_id: run.id }));
      process.exitCode = 0;
    } else {
      if (mode === "reconcile-upstream") run = await reconcileUpstream(run.directory, JSON.parse(readFileSync(0, "utf8")));
      json(manifest.progress, { directory: run.directory, id: run.id, phase: run.phase });
      run = await runUntilBoundary(run.directory);
      const summary = await withControllerLease(run, async () => {
        const result = status(run);
        let candidate = null;
        if (result.phase === "CONVERGED") {
          const current = await captureFingerprint(run.args);
          assertCompleteFingerprint(current);
          candidate = { head: run.fingerprint.headOid,
            base: run.initialFingerprint.mergeBaseOid ?? run.fingerprint.baseOid ?? run.fingerprint.headOid,
            clean: current.fingerprint === run.fingerprint.fingerprint && !checkoutDirty(run.root),
            commitMode: run.options.commitMode };
        }
        return { directory: run.directory, id: run.id, phase: result.phase, outcome: result.outcome,
        waiting: result.waiting, question: result.question, providerCoverage: result.providerCoverage,
        commitRange: result.commitRange, findings: result.findings, cleanupBlocked: result.cleanupBlocked,
        applicationRecovery: result.applicationRecovery, fingerprint: run.fingerprint.fingerprint,
        head: run.fingerprint.headOid, contractHash: run.contractHash, candidate };
      }, () => ({ directory: run.directory, id: run.id, phase: run.phase, waiting: true, candidate: null }));
      json(manifest.progress, summary);
      process.stdout.write(JSON.stringify(summary));
    }
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
});
