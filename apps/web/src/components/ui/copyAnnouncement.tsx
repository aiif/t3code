/** Announces a completed copy without adding visible chrome; mount it before `copied` flips. */
export function CopyAnnouncement({
  copied,
  label,
}: {
  readonly copied: boolean;
  readonly label: string;
}) {
  return (
    <span aria-atomic="true" aria-live="polite" className="sr-only">
      {copied ? label : ""}
    </span>
  );
}
