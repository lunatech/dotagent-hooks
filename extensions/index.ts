import type { HookAPI } from "../lib/hook-api.ts";
import askMode from "../pre/ask-mode.ts";
import commandSafetyHook from "../pre/command-safety.ts";
import guardAwsWrite from "../pre/guard-aws-write.ts";
import guardCurlWrite from "../pre/guard-curl-write.ts";
import guardGcxWrite from "../pre/guard-gcx-write.ts";
import guardGhPrDiscussion from "../pre/guard-gh-pr-discussion.ts";
import guardKubectlWrite from "../pre/guard-kubectl-write.ts";
import guardPkgInstall from "../pre/guard-pkg-install.ts";

const hookFactories = [
  commandSafetyHook,
  guardAwsWrite,
  guardCurlWrite,
  guardGcxWrite,
  guardGhPrDiscussion,
  guardKubectlWrite,
  guardPkgInstall,
  askMode,
] satisfies Array<(pi: HookAPI) => void>;

export default function piExtension(pi: HookAPI): void {
  for (const hookFactory of hookFactories) hookFactory(pi);
}
