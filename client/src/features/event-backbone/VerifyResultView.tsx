import type { VerifyResult } from "./types";
import { shortHash } from "./shared";

/** What a chain verification found, in words an auditor can repeat. */
export function VerifyResultView({ result }: { result: VerifyResult }) {
  const { checkpoints, anchor } = result;
  return (
    <div
      className={`mt-4 rounded-lg border p-4 text-sm ${
        result.ok ? "border-emerald-800 bg-emerald-950/40 text-emerald-200" : "border-red-800 bg-red-950/40 text-red-200"
      }`}
      role="status"
    >
      {result.ok ? (
        <p className="font-medium">
          Chain intact: {result.checked.toLocaleString()} entries checked
          {result.head ? `, through #${result.head.id} (${shortHash(result.head.hash)})` : ""}.
        </p>
      ) : (
        <p className="font-medium">
          {result.firstBrokenId !== null ? `Broken at entry #${result.firstBrokenId}. ` : "Verification failed. "}
          {result.reason}
        </p>
      )}
      {!result.ok && result.firstBrokenId !== null && (
        <p className="mt-1 text-red-300/80">
          {result.checked.toLocaleString()} entries before it are intact. Entries from #{result.firstBrokenId} on
          cannot be trusted until the cause is found.
        </p>
      )}
      {anchor && (
        <p className="mt-1 opacity-80">
          Older entries were archived: this log starts at checkpoint #{anchor.id}, which vouches for{" "}
          {anchor.archivedCount.toLocaleString()} earlier entries ending in {shortHash(anchor.archivedHeadHash)}.
        </p>
      )}
      <p className="mt-1 opacity-80">
        {checkpoints.checked} signed checkpoint{checkpoints.checked === 1 ? "" : "s"} checked
        {checkpoints.invalid.length ? `; signature does not match on #${checkpoints.invalid.join(", #")}` : ""}
        {checkpoints.unknownKey.length
          ? `; #${checkpoints.unknownKey.join(", #")} signed with a key this server no longer has`
          : ""}
        .
      </p>
    </div>
  );
}
