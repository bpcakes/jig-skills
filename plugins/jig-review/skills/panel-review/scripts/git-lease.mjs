import { AsyncLocalStorage } from "node:async_hooks";

// Only trusted controller Git calls inherit this descriptor. Model/validation
// jobs have separate launches and never receive the controller's lease fd.
const context = new AsyncLocalStorage();
const enforcement = new AsyncLocalStorage();
export const activeGitLease = () => context.getStore();
export const withGitLease = (lease, callback) => context.run(lease, callback);
// Fixed host entry points enter this before preflight, when no lease exists yet.
// This process-local policy is not inherited by isolated model/validation jobs.
export const withEnforcedGit = callback => enforcement.run(true, callback);
export const enforcedGit = () => enforcement.getStore() === true || Boolean(activeGitLease());
export const gitStdio = streams => {
  const current = activeGitLease();
  return current ? [...streams, current.fd] : streams;
};
